import { env } from "cloudflare:workers";
import { ButtonStyle, InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_CRON } from "../src/jobs/scheduled";
import { formatRange } from "../src/time";
import {
  ADMIN_ID,
  ADMIN_PERMS,
  button,
  CHANNEL_ID,
  command,
  FakeDiscord,
  interact,
  MEMBER_ID,
  modal,
  nowSec,
  resetDb,
  runCron,
  SECRET_CHANNEL_ID,
  seedEvent,
  seedMessage,
  seedPoll,
  seedServer,
  seedVote,
  select,
} from "./helpers";

const HOUR = 3600;
const DAY = 86400;
const OTHER_GUILD = "210000000000000001";
const TOKYO = "Asia/Tokyo";
const admin = { userId: ADMIN_ID, permissions: ADMIN_PERMS };

let discord: FakeDiscord;

beforeEach(async () => {
  await resetDb();
  discord = new FakeDiscord();
  discord.install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const votesOf = async (userId: string) =>
  (
    await env.DB.prepare("SELECT candidate_id, value FROM poll_votes WHERE user_id = ?1 ORDER BY candidate_id")
      .bind(userId)
      .all<{ candidate_id: number; value: string }>()
  ).results;

/** 来年の日付（JST）を UNIX 秒で */
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const jst = (md: string, hm: string) => Date.parse(`${NEXT_YEAR}-${md}T${hm}:00+09:00`) / 1000;
/** JST の曜日 */
const wd = (unix: number) => "日月火水木金土"[new Date((unix + 9 * HOUR) * 1000).getUTCDay()];

type Row = { components: { custom_id: string; label: string; style: number; disabled?: boolean }[] };

/** 回答パネルの、候補日ごとの行（ページ送りの行を除く） */
const voteRows = (panel: { components: Row[] }) =>
  panel.components.filter((r) => r.components.some((c) => c.custom_id.startsWith("poll:v:")));

describe("/poll の作成", () => {
  it("運営者以外にはモーダルを出さない", async () => {
    await seedServer();
    const res = await interact(command("poll"));
    expect(res.data.content).toContain("運営者");
  });

  it("運営者には候補日・所要時間を含むモーダルを出す（/setup をしていなくても管理権限があれば使える）", async () => {
    const res = await interact(command("poll", [], admin));
    expect(res.type).toBe(InteractionResponseType.Modal);
    const ids = res.data.components.map((row: { components: { custom_id: string }[] }) => row.components[0]!.custom_id);
    expect(ids).toEqual(["title", "candidates", "duration", "location", "description"]);
  });

  it("候補日を日時順に保存し、コマンドを実行したチャンネルに投票メッセージを投稿する", async () => {
    await seedServer();
    await interact(
      modal(
        "poll:create",
        {
          title: "ボドゲ会",
          candidates: `${NEXT_YEAR}-10-18 19:00\n${NEXT_YEAR}-10-11 19:00\n\n${NEXT_YEAR}/10/12 14:00`,
          duration: "3h",
          location: "#voice-1",
        },
        { ...admin, channelId: SECRET_CHANNEL_ID },
      ),
    );
    const poll = await env.DB.prepare("SELECT * FROM polls").first<Record<string, unknown>>();
    expect(poll).toMatchObject({ title: "ボドゲ会", duration_minutes: 180, state: "open", channel_id: SECRET_CHANNEL_ID });
    const starts = (await env.DB.prepare("SELECT start_at FROM poll_candidates ORDER BY position").all()).results.map(
      (r) => r.start_at,
    );
    expect(starts).toEqual([jst("10-11", "19:00"), jst("10-12", "14:00"), jst("10-18", "19:00")]);

    const [posted] = discord.callsTo("POST", /^\/channels\/\d+\/messages$/);
    expect(posted!.path).toBe(`/channels/${SECRET_CHANNEL_ID}/messages`);
    const embed = posted!.body.embeds[0];
    expect(embed.title).toBe("🗳️ ボドゲ会（日程調整）");
    expect(embed.description).toContain("所要時間　3時間");
    expect(embed.fields).toEqual([{ name: "回答状況", value: expect.stringContaining("まだ回答はありません") }]);
    expect(embed.footer.text).toContain("〇 参加できる　△ たぶん　× 参加できない　－ 未回答");
    expect(JSON.stringify(posted!.body)).not.toContain("<t:");
    expect(posted!.body.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([
      `poll:vote:${poll!.id}`,
      `poll:detail:${poll!.id}`,
    ]);
    expect(poll!.message_id).toBe([...discord.messages.keys()][0]);
    expect(discord.followups()[0].content).toContain("日程調整を投稿しました");
  });

  it("bot が入っていないチャンネルでは、追加の仕方を案内して日程調整を残さない", async () => {
    await seedServer();
    discord.forbiddenChannels.add(SECRET_CHANNEL_ID);
    await interact(
      modal(
        "poll:create",
        { title: "x", candidates: `${NEXT_YEAR}-10-11 19:00\n${NEXT_YEAR}-10-12 19:00` },
        { ...admin, channelId: SECRET_CHANNEL_ID },
      ),
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first("n")).toBe(0);
    expect(discord.followups()[0].content).toContain("bot（または bot のロール）を追加");
  });

  it("候補日が読めなければ、何行目かを示して拒否する", async () => {
    await seedServer();
    const res = await interact(
      modal("poll:create", { title: "x", candidates: `${NEXT_YEAR}-10-11 19:00\nあさって` }, admin),
    );
    expect(res.data.content).toContain("2 行目「あさって」");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first("n")).toBe(0);
  });

  it("候補日が 1 つだけなら拒否する", async () => {
    await seedServer();
    const res = await interact(modal("poll:create", { title: "x", candidates: `${NEXT_YEAR}-10-11 19:00` }, admin));
    expect(res.data.content).toContain("2 つ以上");
  });
});

describe("投票メッセージの表", () => {
  it("縦が日付・横がメンバーの表で 〇△× を出し、未回答は － にする", async () => {
    await seedServer();
    const c1Start = jst("11-12", "19:00");
    const c2Start = jst("11-13", "19:00");
    const messageId = seedMessage(discord, "所要時間　2時間\n主催　<@1>");
    const { pollId, candidateIds } = await seedPoll({ starts: [c1Start, c2Start], messageId });
    const [c1, c2] = candidateIds as [number, number];
    await seedVote(c1, "u1", "yes");
    await seedVote(c1, "u2", "maybe");
    await seedVote(c2, "u1", "no");
    // u3 の回答は回答パネルから入れる（投票メッセージが描き直される）
    await interact(button(`poll:v:${pollId}:${c2}:yes:0`, {}, { userId: "u3" }));

    const embed = discord.messages.get(messageId)!.embeds[0]!;
    expect(embed.description).toBe("所要時間　2時間\n主催　<@1>");
    const [table, members, best] = embed.fields!;
    expect(table!.name).toBe("回答状況");
    expect(table!.value).toBe(
      [
        "```",
        `${" ".repeat(14)} ＡＢＣ`,
        `11/12(${wd(c1Start)})19:00 〇△－`,
        `11/13(${wd(c2Start)})19:00 ×－〇`,
        "```",
      ].join("\n"),
    );
    expect(members).toEqual({ name: "メンバー", value: "Ａ <@u1>　Ｂ <@u2>　Ｃ <@u3>" });
    expect(best!.name).toBe("⭐ 〇が多い日");
    expect(best!.value.split("\n")).toHaveLength(2);
    expect(embed.footer!.text).toContain("回答 3人");
  });

  it("列は最初に回答した順に固定され、回答を変えても動かない", async () => {
    await seedServer();
    const messageId = seedMessage(discord);
    const base = nowSec() + 10 * DAY;
    const { pollId, candidateIds } = await seedPoll({ starts: [base, base + DAY], messageId });
    await seedVote(candidateIds[0]!, "u1", "yes");
    await seedVote(candidateIds[0]!, "u2", "yes");
    await interact(button(`poll:v:${pollId}:${candidateIds[0]}:no:0`, {}, { userId: "u1" }));
    const members = discord.messages.get(messageId)!.embeds[0]!.fields!.find((f) => f.name === "メンバー");
    expect(members!.value).toBe("Ａ <@u1>　Ｂ <@u2>");
  });

  it("スマホで折り返さないよう、6 人ごとに表を分ける。19 人目以降は詳細で見る", async () => {
    await seedServer();
    const messageId = seedMessage(discord);
    const base = nowSec() + 10 * DAY;
    const { pollId, candidateIds } = await seedPoll({ starts: [base, base + DAY], messageId });
    for (let i = 1; i <= 19; i++) await seedVote(candidateIds[0]!, `u${i}`, "yes");
    await interact(button(`poll:v:${pollId}:${candidateIds[1]}:yes:0`, {}, { userId: "u1" }));

    const fields = discord.messages.get(messageId)!.embeds[0]!.fields!;
    expect(fields.map((f) => f.name)).toEqual([
      "回答状況（Ａ〜Ｆ）",
      "回答状況（Ｇ〜Ｌ）",
      "回答状況（Ｍ〜Ｒ）",
      "メンバー",
      "⭐ 〇が多い日",
    ]);
    expect(fields[0]!.value.split("\n")[1]).toBe(`${" ".repeat(14)} ＡＢＣＤＥＦ`);
    expect(fields[3]!.value).toContain("他 1 人の回答は [📋 詳細] で確認できます");
  });
});

describe("回答パネル（日付ごとの 〇△× ボタンと、予定の参照）", () => {
  it("候補日ごとに [日付][〇][△][×] を並べ、他サーバーの予定や別の日程調整との重なりを本人にだけ表示する", async () => {
    await seedServer();
    await seedServer({ guild_id: OTHER_GUILD });
    discord.guilds.set(OTHER_GUILD, "サーバーB");
    const base = nowSec() + 10 * DAY;
    const { pollId, candidateIds } = await seedPoll({ starts: [base, base + DAY, base + 2 * DAY], messageId: seedMessage(discord) });

    // 1 つ目の候補と重なる、別サーバーの確定イベント（参加）
    const busyEvent = await seedEvent({ startAt: base + HOUR, title: "読書会", guildId: OTHER_GUILD, messageId: "77" });
    await env.DB.prepare("INSERT INTO responses VALUES (?1, ?2, 'going', 1)").bind(busyEvent, MEMBER_ID).run();
    // 3 つ目の候補と重なる、別の日程調整の候補（〇）
    const other = await seedPoll({ starts: [base + 2 * DAY - HOUR], title: "カラオケ", guildId: OTHER_GUILD });
    await seedVote(other.candidateIds[0]!, MEMBER_ID, "yes");
    // 別の日程調整で × を付けた候補は「予定」ではないので重なりに出さない
    const declined = await seedPoll({ starts: [base + DAY], title: "行けない会", guildId: OTHER_GUILD });
    await seedVote(declined.candidateIds[0]!, MEMBER_ID, "no");
    // 自分の今の回答
    await seedVote(candidateIds[1]!, MEMBER_ID, "maybe");

    const res = await interact(button(`poll:vote:${pollId}`));
    expect(res.type).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
    expect(res.data.flags).toBe(MessageFlags.Ephemeral);

    const panel = discord.followups()[0];
    expect(JSON.stringify(panel)).not.toContain("<t:");
    const lines: string[] = panel.embeds[0].description.split("\n");
    expect(lines[0]).toMatch(/あなた: －$/);
    expect(lines[1]).toContain("⚠️ **サーバーB**");
    expect(lines[1]).toContain("[読書会](https://discord.com/channels/");
    expect(lines[1]).toMatch(/✅$/);
    expect(lines[2]).toMatch(/あなた: △$/);
    expect(lines[3]).toMatch(/あなた: －$/);
    expect(lines[4]).toContain("カラオケ");
    expect(lines[4]).toContain("（日程調整中）");
    expect(lines.join("\n")).not.toContain("行けない会");
    expect(panel.embeds[0].footer.text).toContain("2 件の候補日");

    const rows = voteRows(panel);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.components.map((c) => c.label))).toEqual([
      [expect.stringMatching(/ ⚠️$/), "〇", "△", "×"],
      [expect.not.stringContaining("⚠️"), "〇", "△", "×"],
      [expect.stringMatching(/ ⚠️$/), "〇", "△", "×"],
    ]);
    expect(rows[0]!.components[0]!.disabled).toBe(true);
    // 今の回答（2 つ目の候補の △）だけ色が付く
    expect(rows[1]!.components.slice(1).map((c) => c.style)).toEqual([
      ButtonStyle.Secondary,
      ButtonStyle.Primary,
      ButtonStyle.Secondary,
    ]);
    expect(rows[0]!.components.slice(1).every((c) => c.style === ButtonStyle.Secondary)).toBe(true);
  });

  it("他の予定がなければ、重なりなしと表示する", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const { pollId } = await seedPoll({ starts: [base, base + DAY] });
    await interact(button(`poll:vote:${pollId}`));
    expect(discord.followups()[0].embeds[0].footer.text).toContain("重なっていません");
  });

  it("押すとすぐ保存し、別の記号で上書き、同じ記号をもう一度押すと取り消し（－）にする", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const { pollId, candidateIds } = await seedPoll({ starts: [base, base + DAY], messageId: seedMessage(discord) });
    const [c1, c2] = candidateIds as [number, number];

    const res = await interact(button(`poll:v:${pollId}:${c1}:yes:0`));
    expect(res.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    await interact(button(`poll:v:${pollId}:${c2}:no:0`));
    expect(await votesOf(MEMBER_ID)).toEqual([
      { candidate_id: c1, value: "yes" },
      { candidate_id: c2, value: "no" },
    ]);

    await interact(button(`poll:v:${pollId}:${c1}:maybe:0`));
    expect(await votesOf(MEMBER_ID)).toEqual([
      { candidate_id: c1, value: "maybe" },
      { candidate_id: c2, value: "no" },
    ]);

    await interact(button(`poll:v:${pollId}:${c2}:no:0`));
    expect(await votesOf(MEMBER_ID)).toEqual([{ candidate_id: c1, value: "maybe" }]);

    // 回答パネルも最新の回答で描き直される
    const rows = voteRows(discord.followups().at(-1));
    expect(rows[0]!.components.slice(1).map((c) => c.style)).toEqual([
      ButtonStyle.Secondary,
      ButtonStyle.Primary,
      ButtonStyle.Secondary,
    ]);
    expect(rows[1]!.components.slice(1).every((c) => c.style === ButtonStyle.Secondary)).toBe(true);
  });

  it("〇・△・× の色はそれぞれ緑・青・赤", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const { pollId, candidateIds } = await seedPoll({ starts: [base, base + DAY, base + 2 * DAY] });
    await seedVote(candidateIds[0]!, MEMBER_ID, "yes");
    await seedVote(candidateIds[1]!, MEMBER_ID, "maybe");
    await seedVote(candidateIds[2]!, MEMBER_ID, "no");
    await interact(button(`poll:vote:${pollId}`));
    const rows = voteRows(discord.followups()[0]);
    expect(rows.map((r) => r.components.find((c) => c.style !== ButtonStyle.Secondary)!.label)).toEqual(["〇", "△", "×"]);
    expect(rows.map((r) => r.components.find((c) => c.style !== ButtonStyle.Secondary)!.style)).toEqual([
      ButtonStyle.Success,
      ButtonStyle.Primary,
      ButtonStyle.Danger,
    ]);
  });

  it("候補日が 5 つを超えたら 4 つずつのページに分け、ページ送りのボタンを付ける", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const starts = Array.from({ length: 6 }, (_, i) => base + i * DAY);
    const { pollId, candidateIds } = await seedPoll({ starts });

    await interact(button(`poll:vote:${pollId}`));
    const first = discord.followups()[0];
    expect(voteRows(first)).toHaveLength(4);
    const nav = first.components.at(-1).components;
    expect(nav.map((c: { label: string }) => c.label)).toEqual(["◀ 前へ", "1 / 2", "次へ ▶"]);
    expect(nav[0].disabled).toBe(true);

    const res = await interact(button(nav[2].custom_id));
    expect(res.type).toBe(InteractionResponseType.DeferredMessageUpdate);
    const second = discord.followups().at(-1);
    expect(voteRows(second).map((r) => r.components[1]!.custom_id)).toEqual([
      `poll:v:${pollId}:${candidateIds[4]}:yes:1`,
      `poll:v:${pollId}:${candidateIds[5]}:yes:1`,
    ]);

    // 2 ページ目で押すと、2 ページ目のまま描き直す
    await interact(button(`poll:v:${pollId}:${candidateIds[5]}:yes:1`));
    expect(voteRows(discord.followups().at(-1))[1]!.components[1]!.style).toBe(ButtonStyle.Success);
  });

  it("候補日が 5 つまでならページ送りは出さない", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const { pollId } = await seedPoll({ starts: Array.from({ length: 5 }, (_, i) => base + i * DAY) });
    await interact(button(`poll:vote:${pollId}`));
    const panel = discord.followups()[0];
    expect(panel.components).toHaveLength(5);
    expect(voteRows(panel)).toHaveLength(5);
  });

  it("開始済みの候補はボタンを出さず、押されても変更しない", async () => {
    await seedServer();
    const now = nowSec();
    const { pollId, candidateIds } = await seedPoll({ starts: [now - HOUR, now + DAY] });
    await seedVote(candidateIds[0]!, MEMBER_ID, "yes");

    await interact(button(`poll:vote:${pollId}`));
    const rows = voteRows(discord.followups()[0]);
    expect(rows.map((r) => r.components[1]!.custom_id)).toEqual([`poll:v:${pollId}:${candidateIds[1]}:yes:0`]);

    await interact(button(`poll:v:${pollId}:${candidateIds[0]}:no:0`));
    expect(await votesOf(MEMBER_ID)).toEqual([{ candidate_id: candidateIds[0], value: "yes" }]);
  });

  it("以前のセレクトメニュー式のパネルから操作されたら、開き直すよう案内する", async () => {
    await seedServer();
    const { pollId, candidateIds } = await seedPoll({ starts: [nowSec() + DAY, nowSec() + 2 * DAY] });
    const res = await interact(select(`poll:yes:${pollId}`, [String(candidateIds[0])]));
    expect(res.data.content).toContain("開き直してください");
    expect(await votesOf(MEMBER_ID)).toEqual([]);
  });

  it("他サーバーの日程調整には回答できない", async () => {
    await seedServer();
    const { pollId, candidateIds } = await seedPoll({ starts: [nowSec() + DAY, nowSec() + 2 * DAY] });
    const res = await interact(button(`poll:vote:${pollId}`, {}, { guildId: "999" }));
    expect(res.data.content).toContain("見つかりません");
    const vote = await interact(button(`poll:v:${pollId}:${candidateIds[0]}:yes:0`, {}, { guildId: "999" }));
    expect(vote.data.content).toContain("見つかりません");
    expect(await votesOf(MEMBER_ID)).toEqual([]);
  });
});

describe("確定・中止", () => {
  async function seedOpenPoll() {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const messageId = seedMessage(discord, "所要時間　3時間\n場所　#voice-1\n主催　<@1>\n\n説明文");
    const poll = await seedPoll({ starts: [base, base + DAY], messageId, durationMinutes: 180 });
    const [c1, c2] = poll.candidateIds as [number, number];
    await seedVote(c2, "u1", "yes");
    await seedVote(c2, "u2", "maybe");
    await seedVote(c2, "u4", "no");
    await seedVote(c1, "u3", "yes");
    return { ...poll, c1, c2, base, messageId };
  }

  it("詳細: 全員の回答を表示し、確定・中止の操作は運営者にだけ出す", async () => {
    const { pollId } = await seedOpenPoll();
    const asMember = await interact(button(`poll:detail:${pollId}`));
    expect(asMember.data.flags).toBe(MessageFlags.Ephemeral);
    expect(asMember.data.embeds[0].description).toContain("〇 参加できる (1) <@u1>");
    expect(asMember.data.embeds[0].description).toContain("× 参加できない (1) <@u4>");
    expect(asMember.data.components).toEqual([]);

    const asAdmin = await interact(button(`poll:detail:${pollId}`, {}, admin));
    expect(asAdmin.data.components[0].components[0].custom_id).toBe(`poll:pick:${pollId}`);
    expect(asAdmin.data.components[0].components[0].options[1].label).toMatch(/　〇1 △1 ×1$/);
    expect(asAdmin.data.components[1].components[0].custom_id).toBe(`poll:cancel:${pollId}`);
  });

  it("運営者以外は確定できない（ボタンが見えるかに関係なく確認する）", async () => {
    const { pollId, c2 } = await seedOpenPoll();
    const res = await interact(button(`poll:confirm:${pollId}:${c2}`));
    expect(res.data.content).toContain("運営者");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(0);
  });

  it("確定すると、〇→参加・△→未定・×→不参加で引き継いだイベントになり、投票メッセージが告知に切り替わる", async () => {
    const { pollId, c2, base, messageId } = await seedOpenPoll();

    const confirm = await interact(select(`poll:pick:${pollId}`, [String(c2)], {}, admin));
    expect(confirm.type).toBe(InteractionResponseType.UpdateMessage);
    expect(confirm.data.content).toContain("〇 の 1 人は「参加」、△ の 1 人は「未定」、× の 1 人は「不参加」");

    const res = await interact(button(`poll:confirm:${pollId}:${c2}`, {}, admin));
    expect(res.type).toBe(InteractionResponseType.DeferredMessageUpdate);

    const event = await env.DB.prepare("SELECT * FROM events").first<Record<string, unknown>>();
    expect(event).toMatchObject({
      title: "ボドゲ会",
      start_at: base + DAY,
      duration_minutes: 180,
      message_id: messageId,
      state: "scheduled",
    });
    const responses = (await env.DB.prepare("SELECT user_id, status FROM responses ORDER BY user_id").all()).results;
    expect(responses).toEqual([
      { user_id: "u1", status: "going" },
      { user_id: "u2", status: "maybe" },
      { user_id: "u4", status: "declined" },
    ]);
    // 日程調整（候補・投票）は消える
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM polls").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_votes").first("n")).toBe(0);

    const msg = discord.messages.get(messageId)!;
    expect(msg.embeds[0]!.title).toBe("📅 ボドゲ会");
    expect(msg.embeds[0]!.description).toBe(
      `日時　${formatRange(base + DAY, 180, TOKYO, nowSec())}\n場所　#voice-1\n主催　<@1>\n\n説明文`,
    );
    expect(msg.embeds[0]!.description).not.toContain("<t:");
    expect(msg.embeds[0]!.fields![0]).toEqual({ name: "✅ 参加 (1)", value: "<@u1>" });
    expect(msg.embeds[0]!.fields![2]).toEqual({ name: "❌ 不参加 (1)", value: "<@u4>" });
    expect((msg.components[0] as { components: { custom_id: string }[] }).components[0]!.custom_id).toBe(
      `rsvp:${event!.id}:going`,
    );
    expect(discord.followups()[0].content).toContain("確定しました");

    // 二重に確定しても、イベントは 1 つだけ
    await interact(button(`poll:confirm:${pollId}:${c2}`, {}, admin));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first("n")).toBe(1);
  });

  it("中止すると回答ボタンが消え、【中止】になる", async () => {
    const { pollId, messageId } = await seedOpenPoll();
    const confirm = await interact(button(`poll:cancel:${pollId}`, {}, admin));
    expect(confirm.data.components[0].components[0].custom_id).toBe(`poll:cancelok:${pollId}`);
    await interact(button(`poll:cancelok:${pollId}`, {}, admin));
    expect(await env.DB.prepare("SELECT state FROM polls").first("state")).toBe("cancelled");
    const msg = discord.messages.get(messageId)!;
    expect(msg.embeds[0]!.title).toBe("【中止】🗳️ ボドゲ会（日程調整）");
    expect(msg.components).toEqual([]);
    const again = await interact(button(`poll:vote:${pollId}`));
    expect(again.data.content).toContain("受付を終了");
  });
});

describe("確定イベントの回答時の重なり警告", () => {
  it("参加にしたとき、他サーバーの予定と重なれば本人にだけ知らせる", async () => {
    await seedServer();
    await seedServer({ guild_id: OTHER_GUILD });
    discord.guilds.set(OTHER_GUILD, "サーバーB");
    const start = nowSec() + 10 * DAY;
    const busy = await seedEvent({ startAt: start - HOUR, title: "ボドゲ会", guildId: OTHER_GUILD, durationMinutes: 180 });
    await env.DB.prepare("INSERT INTO responses VALUES (?1, ?2, 'going', 1)").bind(busy, MEMBER_ID).run();
    const target = await seedEvent({ startAt: start, title: "読書会" });

    const res = await interact(button(`rsvp:${target}:going`, { embeds: [{ description: "h" }] }));
    expect(res.type).toBe(InteractionResponseType.UpdateMessage);
    const [warning] = discord.extraMessages();
    expect(warning.flags).toBe(MessageFlags.Ephemeral);
    expect(warning.content).toContain("「読書会」の時間帯に、他の予定があります");
    expect(warning.content).toContain("**サーバーB**");
    expect(warning.content).toContain("ボドゲ会");
    expect(warning.content).toContain(formatRange(start - HOUR, 180, TOKYO, nowSec()));
    expect(warning.content).not.toContain("<t:");
  });

  it("重ならない・不参加にした場合は何も送らない", async () => {
    await seedServer();
    const start = nowSec() + 10 * DAY;
    const busy = await seedEvent({ startAt: start + 3 * HOUR, title: "後の予定" });
    await env.DB.prepare("INSERT INTO responses VALUES (?1, ?2, 'going', 1)").bind(busy, MEMBER_ID).run();
    const target = await seedEvent({ startAt: start, durationMinutes: 120 });
    await interact(button(`rsvp:${target}:going`, { embeds: [] }));
    const overlapping = await seedEvent({ startAt: start + 3 * HOUR });
    await interact(button(`rsvp:${overlapping}:declined`, { embeds: [] }));
    expect(discord.extraMessages()).toEqual([]);
  });
});

describe("/my・/forget・削除ジョブとの連携", () => {
  it("/my に回答中の日程調整を 〇△× で出す", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const { candidateIds } = await seedPoll({ starts: [base, base + DAY], messageId: "66" });
    await seedVote(candidateIds[0]!, MEMBER_ID, "yes");
    await seedVote(candidateIds[1]!, MEMBER_ID, "no");
    await interact(command("my"));
    const [embed] = discord.followups()[0].embeds;
    expect(embed.title).toBe("🗳️ 回答中の日程調整");
    expect(embed.description).toContain("[ボドゲ会](https://discord.com/channels/");
    expect(embed.description).toContain("〇、");
    expect(embed.description).toMatch(/×$/);
    expect(embed.description).not.toContain("<t:");
  });

  it("/forget すべて: 日程調整の回答も消し、投票メッセージを描き直す", async () => {
    await seedServer();
    const base = nowSec() + 10 * DAY;
    const messageId = seedMessage(discord);
    const { candidateIds } = await seedPoll({ starts: [base, base + DAY], messageId });
    await seedVote(candidateIds[0]!, MEMBER_ID, "yes");
    await seedVote(candidateIds[0]!, "u2", "yes");

    const confirm = await interact(button("forget:all"));
    expect(confirm.data.content).toContain("ボドゲ会");
    expect(confirm.data.content).toContain("（日程調整）");
    await interact(button("forget:allok"));
    expect(await votesOf(MEMBER_ID)).toEqual([]);
    expect(await votesOf("u2")).toHaveLength(1);
    const members = discord.messages.get(messageId)!.embeds[0]!.fields!.find((f) => f.name === "メンバー");
    expect(members!.value).toBe("Ａ <@u2>");
  });

  it("最後の候補日から保持期間を過ぎた日程調整を削除する", async () => {
    await seedServer();
    const now = nowSec();
    await seedPoll({ starts: [now - 40 * DAY, now - 31 * DAY], title: "古い" });
    await seedPoll({ starts: [now - 40 * DAY, now - 29 * DAY], title: "まだ残す" });
    await runCron(DAILY_CRON, now * 1000);
    const titles = (await env.DB.prepare("SELECT title FROM polls").all()).results.map((r) => r.title);
    expect(titles).toEqual(["まだ残す"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM poll_candidates").first("n")).toBe(2);
  });
});

describe("/event の所要時間", () => {
  it("所要時間を保存し、終了時刻を表示する", async () => {
    await seedServer();
    await interact(
      modal("event:create", { title: "読書会", datetime: `${NEXT_YEAR}-10-11 19:00`, duration: "1時間30分" }, admin),
    );
    const event = await env.DB.prepare("SELECT start_at, duration_minutes FROM events").first<{
      start_at: number;
      duration_minutes: number;
    }>();
    expect(event).toEqual({ start_at: jst("10-11", "19:00"), duration_minutes: 90 });
    const [posted] = discord.callsTo("POST", new RegExp(`^/channels/${CHANNEL_ID}/messages$`));
    expect(posted!.body.embeds[0].description).toContain("19:00〜20:30");
  });

  it("所要時間が読めなければ拒否する", async () => {
    await seedServer();
    const res = await interact(
      modal("event:create", { title: "x", datetime: `${NEXT_YEAR}-10-11 19:00`, duration: "ながめ" }, admin),
    );
    expect(res.data.content).toContain("所要時間");
  });
});
