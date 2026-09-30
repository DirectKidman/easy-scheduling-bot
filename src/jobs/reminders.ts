import type { APIChannel } from "discord-api-types/v10";
import {
  claimReminder,
  listReminderCandidates,
  listResponses,
  releaseReminder,
  type ReminderCandidate,
  type ReminderKind,
} from "../db/queries";
import { DiscordErrorCode, discordRequest, isDiscordError } from "../discord/rest";
import { subrequestBudget, type Env } from "../env";
import { logError } from "../interaction";
import { mention, messageLink } from "../render";

const HOUR = 60 * 60;
/** 前日のリマインド: 開始 24 時間前から */
export const DAY_BEFORE_WINDOW = 24 * HOUR;
/** 当日のリマインド: 開始 2 時間前から（毎時のジョブなので、実際には 1〜2 時間前に届く） */
export const DAY_OF_WINDOW = 2 * HOUR;

/** 1 回のジョブで見るイベント数 */
const EVENTS_PER_RUN = 20;
/** 1 イベントあたり DM を送る最大人数（超えた分はチャンネルでメンション） */
const MAX_DM_PER_EVENT = 20;
/** チャンネル投稿でメンションする最大人数 */
const MAX_MENTIONS = 50;

export interface ReminderStats {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * 送るべきリマインドの種類を決める。
 * - 開始 2 時間以内: 当日のリマインド（前日分が未送信なら、続けて 2 通届かないよう前日分は送らない）
 * - 開始 24 時間以内: 前日のリマインド（イベント作成が 24 時間以内なら送らない）
 */
export function decideReminders(e: ReminderCandidate, now: number): { send?: ReminderKind; skip: ReminderKind[] } {
  const untilStart = e.start_at - now;
  if (untilStart <= DAY_OF_WINDOW) {
    return {
      send: e.reminded_day_of_at === null ? "day_of" : undefined,
      skip: e.reminded_day_before_at === null ? ["day_before"] : [],
    };
  }
  if (e.reminded_day_before_at === null) {
    const createdLate = e.created_at > e.start_at - DAY_BEFORE_WINDOW;
    return createdLate ? { skip: ["day_before"] } : { send: "day_before", skip: [] };
  }
  return { skip: [] };
}

/**
 * リマインドのジョブ。先に送信済みの印を付けてから送り、失敗したら印を外す。
 * ジョブが止まっていた場合でも、開始前のイベントは次回の実行で拾い直す。何度実行しても二重には送らない。
 */
export async function runReminders(env: Env, now: number): Promise<ReminderStats> {
  const stats: ReminderStats = { sent: 0, skipped: 0, failed: 0 };
  const candidates = await listReminderCandidates(env.DB, now, DAY_BEFORE_WINDOW, EVENTS_PER_RUN);
  // Discord API の呼び出し回数の残り。尽きたら残りのイベントは次回（1 時間後）に回す
  const budget = { remaining: subrequestBudget(env) };

  for (const event of candidates) {
    if (budget.remaining < 1) break;
    const { send, skip } = decideReminders(event, now);
    for (const kind of skip) {
      if (await claimReminder(env.DB, event.id, kind, now)) stats.skipped++;
    }
    if (!send || !(await claimReminder(env.DB, event.id, send, now))) continue;

    try {
      await sendReminder(env, event, send, budget);
      stats.sent++;
    } catch (err) {
      logError(`reminder for event ${event.id} failed`, err);
      await releaseReminder(env.DB, event.id, send, now);
      stats.failed++;
    }
  }
  console.log(`reminders: sent ${stats.sent}, skipped ${stats.skipped}, failed ${stats.failed}`);
  return stats;
}

function reminderText(event: ReminderCandidate, kind: ReminderKind): string {
  const when = kind === "day_before" ? "明日" : "まもなく";
  const link = event.message_id ? `\n告知: ${messageLink(event.guild_id, event.channel_id, event.message_id)}` : "";
  return `⏰ **リマインド**（${when}）「${event.title}」は <t:${event.start_at}:f>（<t:${event.start_at}:R>）に始まります。${link}`;
}

async function sendReminder(
  env: Env,
  event: ReminderCandidate,
  kind: ReminderKind,
  budget: { remaining: number },
): Promise<void> {
  const responses = await listResponses(env.DB, event.id);
  const targets = responses.filter((r) => r.status === "going" || r.status === "maybe").map((r) => r.user_id);
  const text = reminderText(event, kind);

  let channelTargets = targets;
  if (event.reminder_mode === "dm") {
    // DM を閉じている人や、呼び出し回数の都合で DM を送れなかった人は、チャンネルでのメンションに落とす
    channelTargets = [];
    let dmCount = 0;
    let delivered = 0;
    for (const userId of targets) {
      // DM 1 通 = 2 回（DM チャンネル作成 + 送信）。チャンネル投稿の 1 回分は常に残しておく
      const canDm = dmCount < MAX_DM_PER_EVENT && budget.remaining >= 3;
      if (canDm) {
        budget.remaining -= 2;
        dmCount++;
      }
      if (canDm && (await sendDm(env, userId, text))) delivered++;
      else channelTargets.push(userId);
    }
    if (channelTargets.length === 0) return;
    if (delivered > 0) {
      // 一部の DM はもう届いているので、チャンネル投稿に失敗しても再送（＝DM の二重送信）はしない
      try {
        await postToChannel(env, event, text, channelTargets, budget);
      } catch (err) {
        logError(`reminder fallback post for event ${event.id} failed`, err);
      }
      return;
    }
  }

  await postToChannel(env, event, text, channelTargets, budget);
}

async function postToChannel(
  env: Env,
  event: ReminderCandidate,
  text: string,
  channelTargets: string[],
  budget: { remaining: number },
): Promise<void> {
  const shown = channelTargets.slice(0, MAX_MENTIONS);
  const rest = channelTargets.length - shown.length;
  const mentions = shown.length > 0 ? `\n${shown.map(mention).join(" ")}${rest > 0 ? ` 他${rest}人` : ""}` : "";
  budget.remaining -= 1;
  await discordRequest(env, "POST", `/channels/${event.channel_id}/messages`, {
    body: {
      content: text + mentions,
      // 通知はメンションした参加者にだけ飛ばす（@everyone やロールは通知しない）
      allowed_mentions: { parse: [], users: shown },
    },
  });
}

/** DM を送る。相手が DM を閉じているなどで送れなければ false */
async function sendDm(env: Env, userId: string, content: string): Promise<boolean> {
  try {
    const channel = await discordRequest<APIChannel>(env, "POST", "/users/@me/channels", {
      body: { recipient_id: userId },
    });
    await discordRequest(env, "POST", `/channels/${channel.id}/messages`, {
      body: { content, allowed_mentions: { parse: [] } },
    });
    return true;
  } catch (err) {
    if (!isDiscordError(err, DiscordErrorCode.CannotSendMessagesToThisUser)) logError("dm failed", err);
    return false;
  }
}
