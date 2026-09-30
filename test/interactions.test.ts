import { env } from "cloudflare:workers";
import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ID,
  ADMIN_PERMS,
  button,
  callWorker,
  CHANNEL_ID,
  command,
  FakeDiscord,
  GUILD_ID,
  interact,
  MEMBER_ID,
  modal,
  nowSec,
  OPERATOR_ROLE_ID,
  resetDb,
  seedEvent,
  seedServer,
  sign,
} from "./helpers";

let discord: FakeDiscord;

beforeEach(async () => {
  await resetDb();
  discord = new FakeDiscord();
  discord.install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const admin = { userId: ADMIN_ID, permissions: ADMIN_PERMS };
// 来年の 10/11 19:00（JST）
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const EVENT_INPUT = `${NEXT_YEAR}-10-11 19:00`;
const EVENT_UNIX = Date.parse(`${NEXT_YEAR}-10-11T10:00:00Z`) / 1000;

describe("署名検証", () => {
  it("正しい署名の PING に PONG を返す", async () => {
    expect(await interact({ type: 1 })).toEqual({ type: InteractionResponseType.Pong });
  });

  it("署名が不正なら 401", async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = String(nowSec());
    const signature = await sign(timestamp, body + "x");
    const res = await callWorker(
      new Request("https://bot.example/", {
        method: "POST",
        body,
        headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("署名ヘッダーがなければ 401", async () => {
    const res = await callWorker(new Request("https://bot.example/", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("/setup", () => {
  it("管理権限がないと拒否する", async () => {
    const res = await interact(command("setup", [{ name: "channel", type: 7, value: CHANNEL_ID }]));
    expect(res.data.flags).toBe(MessageFlags.Ephemeral);
    expect(res.data.content).toContain("サーバー管理権限");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM servers").first("n")).toBe(0);
  });

  it("設定を保存し、保存データの説明を表示する", async () => {
    const res = await interact(
      command(
        "setup",
        [
          { name: "channel", type: 7, value: CHANNEL_ID },
          { name: "operator_role", type: 8, value: OPERATOR_ROLE_ID },
          { name: "timezone", type: 3, value: "America/New_York" },
        ],
        admin,
      ),
    );
    expect(res.data.content).toContain("設定を保存しました");
    expect(res.data.content).toContain("bot の運営者");
    const row = await env.DB.prepare("SELECT * FROM servers WHERE guild_id = ?1").bind(GUILD_ID).first();
    expect(row).toMatchObject({
      announce_channel_id: CHANNEL_ID,
      operator_role_id: OPERATOR_ROLE_ID,
      timezone: "America/New_York",
    });
  });

  it("不正なタイムゾーンは拒否する", async () => {
    const res = await interact(
      command(
        "setup",
        [
          { name: "channel", type: 7, value: CHANNEL_ID },
          { name: "timezone", type: 3, value: "Mars/Olympus" },
        ],
        admin,
      ),
    );
    expect(res.data.content).toContain("使えません");
  });
});

describe("/event", () => {
  it("未設定のサーバーでは /setup を案内する", async () => {
    const res = await interact(command("event", [], admin));
    expect(res.data.content).toContain("/setup");
  });

  it("運営者以外にはモーダルを出さない", async () => {
    await seedServer({ operator_role_id: OPERATOR_ROLE_ID });
    const res = await interact(command("event"));
    expect(res.type).toBe(InteractionResponseType.ChannelMessageWithSource);
    expect(res.data.content).toContain("運営者");
  });

  it("運営ロールを持つ人にはモーダルを出す", async () => {
    await seedServer({ operator_role_id: OPERATOR_ROLE_ID });
    const res = await interact(command("event", [], { roles: [OPERATOR_ROLE_ID] }));
    expect(res.type).toBe(InteractionResponseType.Modal);
    expect(res.data.custom_id).toBe("event:create");
  });

  it("モーダル送信で UTC で保存し、告知メッセージを投稿する", async () => {
    await seedServer();
    const res = await interact(
      modal(
        "event:create",
        { title: "読書会", datetime: EVENT_INPUT, location: "#voice-1", description: "持ち物なし" },
        admin,
      ),
    );
    expect(res.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    expect(res.data.flags).toBe(MessageFlags.Ephemeral);

    const event = await env.DB.prepare("SELECT * FROM events").first<Record<string, unknown>>();
    expect(event).toMatchObject({ title: "読書会", start_at: EVENT_UNIX });

    const [posted] = discord.callsTo("POST", /^\/channels\/\d+\/messages$/);
    expect(posted!.path).toBe(`/channels/${CHANNEL_ID}/messages`);
    const embed = posted!.body.embeds[0];
    expect(embed.title).toBe("📅 読書会");
    expect(embed.description).toContain(`<t:${EVENT_UNIX}:F>`);
    expect(embed.description).toContain("場所　#voice-1");
    expect(embed.description).toContain(`主催　<@${ADMIN_ID}>`);
    expect(posted!.body.allowed_mentions).toEqual({ parse: [] });
    expect(posted!.body.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([
      `rsvp:${event!.id}:going`,
      `rsvp:${event!.id}:maybe`,
      `rsvp:${event!.id}:declined`,
      `detail:${event!.id}`,
    ]);
    expect(event!.message_id).toBe([...discord.messages.keys()][0]);
    expect(discord.followups()[0].content).toContain("告知しました");
  });

  it("過去の日時は拒否する", async () => {
    await seedServer();
    const res = await interact(modal("event:create", { title: "x", datetime: "2000-01-01 10:00" }, admin));
    expect(res.data.content).toContain("過去");
    const far = await interact(modal("event:create", { title: "x", datetime: "2099-01-01 10:00" }, admin));
    expect(far.data.content).toContain("2年以上先");
  });

  it("投稿できなければイベントを残さずに理由を返す", async () => {
    await seedServer();
    discord.forbiddenChannels.add(CHANNEL_ID);
    await interact(modal("event:create", { title: "x", datetime: EVENT_INPUT }, admin));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(0);
    expect(discord.followups()[0].content).toContain("投稿できませんでした");
  });
});

describe("回答ボタン", () => {
  const header = "日時　<t:4095392400:F>\n主催　<@1>";
  const message = { embeds: [{ title: "📅 読書会", description: header }] };

  it("押したユーザーの回答を保存し、DB からメッセージを再生成する", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() + 3600, messageId: "m1" });

    await interact(button(`rsvp:${id}:going`, message, { userId: "11" }));
    await interact(button(`rsvp:${id}:maybe`, message, { userId: "12" }));
    // 同じ人が回答を変えた場合は上書きされる
    await interact(button(`rsvp:${id}:going`, message, { userId: "13" }));
    const res = await interact(button(`rsvp:${id}:declined`, message, { userId: "13" }));

    expect(res.type).toBe(InteractionResponseType.UpdateMessage);
    const embed = res.data.embeds[0];
    expect(embed.description).toBe(header);
    expect(embed.fields).toEqual([
      { name: "✅ 参加 (1)", value: "<@11>" },
      { name: "🤔 未定 (1)", value: "<@12>" },
      { name: "❌ 不参加 (1)", value: "<@13>" },
    ]);
    expect(res.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("連打しても 1 人 1 回答のまま", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() + 3600 });
    for (let i = 0; i < 5; i++) await interact(button(`rsvp:${id}:going`, message, { userId: "11" }));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM responses").first("n")).toBe(1);
  });

  it("多人数は「他n人」で省略する", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() + 3600 });
    for (let i = 0; i < 22; i++) {
      await env.DB.prepare("INSERT INTO responses VALUES (?1, ?2, 'going', ?3)").bind(id, `u${i}`, i).run();
    }
    const res = await interact(button(`rsvp:${id}:maybe`, message, { userId: "x" }));
    const going = res.data.embeds[0].fields[0];
    expect(going.name).toBe("✅ 参加 (22)");
    expect(going.value).toMatch(/ 他2人$/);
  });

  it("開始済み・他サーバーのイベントは受け付けない", async () => {
    await seedServer();
    const past = await seedEvent({ startAt: nowSec() - 10 });
    expect((await interact(button(`rsvp:${past}:going`, message))).data.content).toContain("開始");
    const other = await seedEvent({ startAt: nowSec() + 3600 });
    const res = await interact(button(`rsvp:${other}:going`, message, { guildId: "999" }));
    expect(res.data.content).toContain("見つかりません");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM responses").first("n")).toBe(0);
  });

  it("詳細ボタンは全員を自分にだけ見える形で表示し、中止ボタンは運営者にだけ出す", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() + 3600 });
    await env.DB.prepare("INSERT INTO responses VALUES (?1, '11', 'going', 1)").bind(id).run();

    const asMember = await interact(button(`detail:${id}`, message));
    expect(asMember.data.flags).toBe(MessageFlags.Ephemeral);
    expect(asMember.data.embeds[0].description).toContain("<@11>");
    expect(asMember.data.components).toEqual([]);

    const asAdmin = await interact(button(`detail:${id}`, message, admin));
    expect(asAdmin.data.components[0].components[0].custom_id).toBe(`cancel:${id}`);
  });

  it("中止ボタンはボタンが見えるかに関係なく毎回権限を確認する", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() + 3600 });
    const res = await interact(button(`cancelok:${id}`, message));
    expect(res.data.content).toContain("運営者だけ");
    expect(await env.DB.prepare("SELECT state FROM events").first("state")).toBe("scheduled");
  });

  it("運営者が中止すると、告知メッセージのボタンを外して【中止】にする", async () => {
    await seedServer();
    const posted = await (
      await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: "POST",
        body: JSON.stringify(message),
      })
    ).json<{ id: string }>();
    const id = await seedEvent({ startAt: nowSec() + 3600, messageId: posted.id });

    const confirm = await interact(button(`cancel:${id}`, message, admin));
    expect(confirm.data.components[0].components[0].custom_id).toBe(`cancelok:${id}`);

    const res = await interact(button(`cancelok:${id}`, message, admin));
    expect(res.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    expect(await env.DB.prepare("SELECT state FROM events").first("state")).toBe("cancelled");
    const edited = discord.messages.get(posted.id)!;
    expect(edited.embeds[0]!.title).toBe("【中止】📅 読書会");
    expect(edited.embeds[0]!.description).toBe(header);
    expect(edited.components).toEqual([]);
    expect(discord.followups()[0].content).toContain("中止しました");

    const again = await interact(button(`rsvp:${id}:going`, message));
    expect(again.data.content).toContain("受付を終了");
  });
});

describe("/my", () => {
  it("導入済みの全サーバーの今後の予定（参加・未定）を横断で表示する", async () => {
    await seedServer();
    await env.DB.prepare("INSERT INTO servers (guild_id, announce_channel_id, timezone) VALUES ('777', '1', 'UTC')").run();
    discord.guilds.set("777", "別サーバー");
    const now = nowSec();
    const a = await seedEvent({ startAt: now + 7200, title: "ボドゲ会", guildId: "777", messageId: "55" });
    const b = await seedEvent({ startAt: now + 3600, title: "読書会", messageId: "66" });
    const declined = await seedEvent({ startAt: now + 3600, title: "不参加の会" });
    const past = await seedEvent({ startAt: now - 3600, title: "過去の会" });
    const insert = env.DB.prepare("INSERT INTO responses VALUES (?1, ?2, ?3, 1)");
    await env.DB.batch([
      insert.bind(a, MEMBER_ID, "maybe"),
      insert.bind(b, MEMBER_ID, "going"),
      insert.bind(declined, MEMBER_ID, "declined"),
      insert.bind(past, MEMBER_ID, "going"),
      insert.bind(b, "someone-else", "going"),
    ]);

    const res = await interact(command("my"));
    expect(res.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    expect(res.data.flags).toBe(MessageFlags.Ephemeral);

    const lines: string[] = discord.followups()[0].embeds[0].description.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("**テストサーバー**");
    expect(lines[0]).toContain(`[読書会](https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/66)`);
    expect(lines[0]).toMatch(/✅$/);
    expect(lines[1]).toContain("**別サーバー**");
    expect(lines[1]).toMatch(/🤔$/);
  });

  it("予定がなければその旨を返す", async () => {
    await interact(command("my"));
    expect(discord.followups()[0].content).toContain("ありません");
  });
});

describe("DM など、サーバー外からの実行", () => {
  it("サーバー内での実行を案内する", async () => {
    const res = await interact({
      id: "1",
      type: 2,
      channel_id: "1",
      user: { id: MEMBER_ID },
      data: { id: "1", name: "my", type: 1 },
    });
    expect(res.data.content).toContain("サーバー内");
  });
});
