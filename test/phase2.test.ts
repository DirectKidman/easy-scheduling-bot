import { env } from "cloudflare:workers";
import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_CRON, DAILY_MESSAGE_CHECK_CRON, HOURLY_CRON } from "../src/jobs/scheduled";
import {
  ADMIN_ID,
  ADMIN_PERMS,
  button,
  CHANNEL_ID,
  command,
  FakeDiscord,
  GUILD_ID,
  interact,
  MEMBER_ID,
  nowSec,
  resetDb,
  runCron,
  seedEvent,
  seedMessage,
  seedServer,
} from "./helpers";

const HOUR = 3600;
const DAY = 86400;

let discord: FakeDiscord;

beforeEach(async () => {
  await resetDb();
  discord = new FakeDiscord();
  discord.install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const responsesOf = async (userId: string) =>
  (
    await env.DB.prepare("SELECT event_id FROM responses WHERE user_id = ?1 ORDER BY event_id")
      .bind(userId)
      .all<{ event_id: number }>()
  ).results.map((r) => r.event_id);

const addResponse = (eventId: number, userId: string, status = "going") =>
  env.DB.prepare("INSERT INTO responses VALUES (?1, ?2, ?3, 1)").bind(eventId, userId, status).run();

describe("/setup のリマインド設定", () => {
  it("DM を選べて、省略時は前の設定を引き継ぐ", async () => {
    const channel = { name: "channel", type: 7, value: CHANNEL_ID };
    const admin = { userId: ADMIN_ID, permissions: ADMIN_PERMS };
    await interact(command("setup", [channel, { name: "reminder", type: 3, value: "dm" }], admin));
    await interact(command("setup", [channel], admin));
    expect(await env.DB.prepare("SELECT reminder_mode FROM servers").first("reminder_mode")).toBe("dm");
  });
});

describe("/forget", () => {
  async function seedHistory() {
    await seedServer();
    const now = nowSec();
    const past = await seedEvent({ startAt: now - DAY, title: "過去の会" });
    const futureMsg = seedMessage(discord);
    const future = await seedEvent({ startAt: now + DAY, title: "今後の会", messageId: futureMsg });
    await addResponse(past, MEMBER_ID);
    await addResponse(future, MEMBER_ID, "declined");
    await addResponse(future, "someone-else");
    return { past, future, futureMsg };
  }

  it("範囲を選ぶ確認画面を自分にだけ見える形で出す", async () => {
    await seedHistory();
    const res = await interact(command("forget"));
    expect(res.data.flags).toBe(MessageFlags.Ephemeral);
    expect(res.data.content).toContain("過去分だけ: 終了済みイベントへの回答 1 件");
    expect(res.data.content).toContain("すべて: 全サーバー分の回答 2 件");
    expect(res.data.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([
      "forget:past",
      "forget:all",
      "forget:cancel",
    ]);
  });

  it("過去分だけ: 終了済みイベントの回答だけを消し、今後の予定には影響しない", async () => {
    const { future } = await seedHistory();
    const res = await interact(button("forget:past"));
    expect(res.type).toBe(InteractionResponseType.UpdateMessage);
    expect(res.data.content).toContain("1 件削除");
    expect(await responsesOf(MEMBER_ID)).toEqual([future]);
    expect(await responsesOf("someone-else")).toEqual([future]);
  });

  it("すべて: 影響を受ける今後の予定を出して確認し、削除後に告知メッセージを再描画する", async () => {
    const { futureMsg } = await seedHistory();
    const confirm = await interact(button("forget:all"));
    expect(confirm.data.content).toContain("今後の会");
    expect(confirm.data.content).toContain("❌");
    expect(confirm.data.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([
      "forget:cancel",
      "forget:allok",
    ]);
    // 確認画面の時点では消さない
    expect(await responsesOf(MEMBER_ID)).toHaveLength(2);

    const res = await interact(button("forget:allok"));
    expect(res.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    expect(await responsesOf(MEMBER_ID)).toEqual([]);
    expect(await responsesOf("someone-else")).toHaveLength(1);
    expect(discord.followups()[0].content).toContain("2 件削除");

    // 「不参加」だった人が消えて「未回答」に戻り、名簿から外れる
    const edited = discord.messages.get(futureMsg)!;
    expect(edited.embeds[0]!.fields).toEqual([
      { name: "✅ 参加 (1)", value: "<@someone-else>" },
      { name: "🤔 未定 (0)", value: "—" },
      { name: "❌ 不参加 (0)", value: "—" },
    ]);
  });

  it("キャンセルでは何も消さない", async () => {
    await seedHistory();
    const res = await interact(button("forget:cancel"));
    expect(res.data.content).toContain("キャンセル");
    expect(await responsesOf(MEMBER_ID)).toHaveLength(2);
  });
});

describe("リマインド", () => {
  const reminderPosts = () =>
    discord.callsTo("POST", new RegExp(`^/channels/${CHANNEL_ID}/messages$`)).map((c) => c.body);

  it("前日のリマインドを参加・未定の人にメンションして 1 回だけ送る", async () => {
    await seedServer();
    const now = nowSec();
    const id = await seedEvent({ startAt: now + 20 * HOUR, messageId: seedMessage(discord) });
    await addResponse(id, "11", "going");
    await addResponse(id, "12", "maybe");
    await addResponse(id, "13", "declined");

    await runCron(HOURLY_CRON, now * 1000);
    await runCron(HOURLY_CRON, now * 1000);

    const posts = reminderPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain("明日");
    expect(posts[0].content).toContain("<@11> <@12>");
    expect(posts[0].content).not.toContain("<@13>");
    expect(posts[0].allowed_mentions).toEqual({ parse: [], users: ["11", "12"] });
  });

  it("前日→当日の順に送り、ジョブが止まっていた分は次の実行で拾い直す", async () => {
    await seedServer();
    const start = nowSec() + 30 * HOUR;
    await seedEvent({ startAt: start, messageId: seedMessage(discord) });

    await runCron(HOURLY_CRON, (start - 25 * HOUR) * 1000); // まだ早い
    expect(reminderPosts()).toHaveLength(0);
    await runCron(HOURLY_CRON, (start - 10 * HOUR) * 1000); // 前日の分（24h 前の実行が漏れていても拾う）
    await runCron(HOURLY_CRON, (start - 90 * 60) * 1000); // 当日の分
    await runCron(HOURLY_CRON, (start - 30 * 60) * 1000); // 送信済みなので何もしない
    await runCron(HOURLY_CRON, (start + 60) * 1000); // 開始後は送らない

    const posts = reminderPosts();
    expect(posts.map((p) => (p.content.includes("明日") ? "day_before" : "day_of"))).toEqual(["day_before", "day_of"]);
  });

  it("当日の時間帯まで前日分が送れていなかったら、当日分だけを送る", async () => {
    await seedServer();
    const start = nowSec() + HOUR;
    await seedEvent({ startAt: start, messageId: seedMessage(discord) });
    await runCron(HOURLY_CRON, nowSec() * 1000);
    const posts = reminderPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain("まもなく");
  });

  it("開始 24 時間以内に作られたイベントには前日のリマインドを送らない", async () => {
    await seedServer();
    const now = nowSec();
    await seedEvent({ startAt: now + 10 * HOUR, createdAt: now - HOUR, messageId: seedMessage(discord) });
    await runCron(HOURLY_CRON, now * 1000);
    expect(reminderPosts()).toHaveLength(0);
  });

  it("送信に失敗したら印を外し、次の実行で送り直す", async () => {
    await seedServer();
    const now = nowSec();
    await seedEvent({ startAt: now + 20 * HOUR, messageId: seedMessage(discord) });
    discord.forbiddenChannels.add(CHANNEL_ID);
    await runCron(HOURLY_CRON, now * 1000);
    expect(await env.DB.prepare("SELECT reminded_day_before_at FROM events").first("reminded_day_before_at")).toBeNull();

    discord.forbiddenChannels.delete(CHANNEL_ID);
    await runCron(HOURLY_CRON, now * 1000);
    expect(reminderPosts().filter((p) => p.content.includes("リマインド"))).toHaveLength(2); // 失敗 1 + 成功 1
    expect(await env.DB.prepare("SELECT reminded_day_before_at FROM events").first("reminded_day_before_at")).toBe(now);
  });

  it("DM モード: DM を送り、DM を閉じている人だけチャンネルでメンションする", async () => {
    await seedServer({ reminder_mode: "dm" });
    const now = nowSec();
    const id = await seedEvent({ startAt: now + 20 * HOUR, messageId: seedMessage(discord) });
    await addResponse(id, "11", "going");
    await addResponse(id, "12", "going");
    discord.closedDms.add("12");

    await runCron(HOURLY_CRON, now * 1000);

    const dms = discord.callsTo("POST", /^\/channels\/dm\d+\/messages$/);
    expect(dms.map((d) => d.path)).toEqual(["/channels/dm11/messages", "/channels/dm12/messages"]);
    const posts = reminderPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].allowed_mentions.users).toEqual(["12"]);
  });

  it("DM モードで全員に DM が届いたらチャンネルには投稿しない", async () => {
    await seedServer({ reminder_mode: "dm" });
    const now = nowSec();
    const id = await seedEvent({ startAt: now + 20 * HOUR, messageId: seedMessage(discord) });
    await addResponse(id, "11", "going");
    await runCron(HOURLY_CRON, now * 1000);
    expect(reminderPosts()).toHaveLength(0);
    expect(discord.callsTo("POST", /^\/channels\/dm11\/messages$/)).toHaveLength(1);
  });

  it("中止したイベントには送らない", async () => {
    await seedServer();
    const now = nowSec();
    const id = await seedEvent({ startAt: now + 20 * HOUR, messageId: seedMessage(discord) });
    await env.DB.prepare("UPDATE events SET state = 'cancelled' WHERE id = ?1").bind(id).run();
    await runCron(HOURLY_CRON, now * 1000);
    expect(reminderPosts()).toHaveLength(0);
  });
});

describe("bot 外しの確認ジョブ", () => {
  const OTHER = "210000000000000001";
  const serverRow = (guildId: string) =>
    env.DB.prepare("SELECT deletion_scheduled_at FROM servers WHERE guild_id = ?1").bind(guildId).first<{
      deletion_scheduled_at: number | null;
    }>();

  it("到達できないサーバーに削除予定の印を付け、猶予期間の後にイベント・回答ごと消す", async () => {
    await seedServer();
    await seedServer({ guild_id: OTHER });
    const now = nowSec();
    const id = await seedEvent({ startAt: now + DAY, guildId: OTHER });
    await addResponse(id, "11");

    await runCron(DAILY_CRON, now * 1000);
    expect((await serverRow(GUILD_ID))!.deletion_scheduled_at).toBeNull();
    expect((await serverRow(OTHER))!.deletion_scheduled_at).toBe(now + 14 * DAY);

    // 猶予期間中は消さない
    await runCron(DAILY_CRON, (now + 7 * DAY) * 1000);
    expect(await serverRow(OTHER)).not.toBeNull();

    await runCron(DAILY_CRON, (now + 14 * DAY) * 1000);
    expect(await serverRow(OTHER)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE guild_id = ?1").bind(OTHER).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM responses").first("n")).toBe(0);
    expect(await serverRow(GUILD_ID)).not.toBeNull();
  });

  it("猶予中に再び到達できたら印を外す（一時的な障害による誤検知対策）", async () => {
    await seedServer({ guild_id: OTHER });
    const now = nowSec();
    await runCron(DAILY_CRON, now * 1000);
    expect((await serverRow(OTHER))!.deletion_scheduled_at).not.toBeNull();

    discord.guilds.set(OTHER, "戻ってきたサーバー");
    await runCron(DAILY_CRON, (now + DAY) * 1000);
    expect((await serverRow(OTHER))!.deletion_scheduled_at).toBeNull();
  });

  it("Discord 側の障害（5xx など）では印を付けない", async () => {
    await seedServer({ guild_id: OTHER });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status: 502 }));
    await runCron(DAILY_CRON, nowSec() * 1000);
    expect((await serverRow(OTHER))!.deletion_scheduled_at).toBeNull();
  });

  it("/setup を実行し直すと印を外す", async () => {
    await seedServer();
    await env.DB.prepare("UPDATE servers SET deletion_scheduled_at = 1").run();
    await interact(
      command("setup", [{ name: "channel", type: 7, value: CHANNEL_ID }], { userId: ADMIN_ID, permissions: ADMIN_PERMS }),
    );
    expect((await serverRow(GUILD_ID))!.deletion_scheduled_at).toBeNull();
  });
});

describe("告知メッセージの存在確認ジョブ", () => {
  it("消された告知メッセージのイベントを message_deleted にし、/my とリマインドから外す", async () => {
    await seedServer();
    const now = nowSec();
    const kept = await seedEvent({ startAt: now + 20 * HOUR, messageId: seedMessage(discord), title: "残る会" });
    const gone = await seedEvent({ startAt: now + 20 * HOUR, messageId: "123456789", title: "消えた会" });
    await addResponse(kept, MEMBER_ID);
    await addResponse(gone, MEMBER_ID);

    await runCron(DAILY_MESSAGE_CHECK_CRON, now * 1000);

    const states = (
      await env.DB.prepare("SELECT id, state FROM events ORDER BY id").all<{ id: number; state: string }>()
    ).results;
    expect(states).toEqual([
      { id: kept, state: "scheduled" },
      { id: gone, state: "message_deleted" },
    ]);

    await interact(command("my"));
    const my = discord.followups()[0].embeds[0].description;
    expect(my).toContain("残る会");
    expect(my).not.toContain("消えた会");
  });
});
