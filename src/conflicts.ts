// 予定の重なり。この bot で管理している予定（全サーバー横断）だけを見る。
// 結果は本人にだけ見えるメッセージでしか出さない（他のメンバーに、別サーバーでの予定を見せないため）。

import type { APIGuild } from "discord-api-types/v10";
import { listOpenPollVotesForUser, type VoteValue } from "./db/polls";
import { listCommitmentsForUser } from "./db/queries";
import { discordRequest } from "./discord/rest";
import type { Env } from "./env";
import { logError } from "./interaction";
import { escapeMarkdown, messageLink, STATUS_META } from "./render";
import { formatRange } from "./time";

export interface Busy {
  kind: "event" | "poll";
  /** イベント ID または日程調整 ID */
  id: number;
  guild_id: string;
  title: string;
  start_at: number;
  end_at: number;
  /** その予定のサーバーのタイムゾーン（表示用） */
  timezone: string;
  /** ✅ 🤔（イベント）/ ⭕ 🔺（日程調整の候補） */
  mark: string;
  link: string | null;
}

export interface Range {
  start: number;
  end: number;
}

/** 日程調整の回答の記号。未回答は NO_VOTE_MARK */
export const VOTE_MARK: Record<VoteValue, string> = { yes: "⭕", maybe: "🔺", no: "❌" };
export const NO_VOTE_MARK = "➖";

/**
 * ユーザーの予定のうち、[from, to) と重なりうるものを集める。
 * - 参加・未定と回答した確定イベント
 * - 受付中の別の日程調整で ⭕・🔺 を付けた候補（❌ は予定ではないので含めない）
 */
export async function collectBusy(
  env: Env,
  userId: string,
  from: number,
  to: number,
  exclude: { eventId?: number; pollId?: number } = {},
): Promise<Busy[]> {
  const [events, votes] = await Promise.all([
    listCommitmentsForUser(env.DB, userId, from, to),
    // 所要時間は最長 7 日なので、その分さかのぼって拾う
    listOpenPollVotesForUser(env.DB, userId, from - 7 * 24 * 60 * 60),
  ]);
  const busy: Busy[] = [];
  for (const e of events) {
    if (e.event_id === exclude.eventId) continue;
    busy.push({
      kind: "event",
      id: e.event_id,
      guild_id: e.guild_id,
      title: e.title,
      start_at: e.start_at,
      end_at: e.start_at + e.duration_minutes * 60,
      timezone: e.timezone,
      mark: STATUS_META[e.status].emoji,
      link: e.message_id ? messageLink(e.guild_id, e.channel_id, e.message_id) : null,
    });
  }
  for (const v of votes) {
    if (v.value === "no") continue;
    const end = v.start_at + v.duration_minutes * 60;
    if (v.poll_id === exclude.pollId || v.start_at >= to || end <= from) continue;
    busy.push({
      kind: "poll",
      id: v.poll_id,
      guild_id: v.guild_id,
      title: v.title,
      start_at: v.start_at,
      end_at: end,
      timezone: v.timezone,
      mark: VOTE_MARK[v.value],
      link: v.message_id ? messageLink(v.guild_id, v.channel_id, v.message_id) : null,
    });
  }
  return busy.sort((a, b) => a.start_at - b.start_at);
}

export function overlapping(busy: Busy[], range: Range): Busy[] {
  return busy.filter((b) => b.start_at < range.end && b.end_at > range.start);
}

/** サーバー名は保存せず、表示のたびに取得する。取得できなければ載せない */
export async function fetchGuildNames(env: Env, guildIds: Iterable<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(guildIds)].map(async (id) => {
      try {
        const guild = await discordRequest<APIGuild>(env, "GET", `/guilds/${id}`);
        names.set(id, guild.name);
      } catch (err) {
        logError("fetch guild name failed", err);
      }
    }),
  );
  return names;
}

/** 本文用の 1 行: 「サーバー名　11/12(水) 19:00〜21:00　タイトル（日程調整中）　✅」 */
export function formatBusyLine(b: Busy, names: Map<string, string>, now?: number): string {
  const server = names.get(b.guild_id);
  const title = escapeMarkdown(b.title);
  const titleText = b.link ? `[${title}](${b.link})` : title;
  const pollNote = b.kind === "poll" ? "（日程調整中）" : "";
  const range = formatRange(b.start_at, (b.end_at - b.start_at) / 60, b.timezone, now);
  return `${server ? `**${escapeMarkdown(server)}**　` : ""}${range}　${titleText}${pollNote}　${b.mark}`;
}
