import { purgePollsBefore } from "../db/polls";
import { purgeEventsBefore } from "../db/queries";
import { retentionDays, type Env } from "../env";
import { logError } from "../interaction";
import { checkAnnouncements, checkGuilds } from "./checks";
import { runReminders } from "./reminders";

// wrangler.jsonc の triggers.crons と一致させる。Cron ごとに別の実行になり、サブリクエスト数の上限も別に数えられる
export const HOURLY_CRON = "0 * * * *";
export const DAILY_CRON = "7 18 * * *";
export const DAILY_MESSAGE_CHECK_CRON = "37 18 * * *";

const DAY = 24 * 60 * 60;

/** 時間経過の削除: 開始日時から保持期間を過ぎたイベント・日程調整と回答を物理削除する（冪等） */
export async function purgeExpiredEvents(env: Env, now: number): Promise<number> {
  const cutoff = now - retentionDays(env) * DAY;
  const deleted = await purgeEventsBefore(env.DB, cutoff);
  // 日程調整は、最後の候補日から保持期間を過ぎたら消す（確定したものはイベントに移って消えている）
  const polls = await purgePollsBefore(env.DB, cutoff);
  console.log(`purge: deleted ${deleted} events, ${polls} polls`);
  return deleted;
}

export async function runScheduled(cron: string, env: Env, now: number): Promise<void> {
  // 1 つのジョブの失敗で残りが止まらないよう、ジョブごとに失敗を閉じ込める
  const run = async (name: string, job: () => Promise<unknown>) => {
    try {
      await job();
    } catch (err) {
      logError(`job ${name} failed`, err);
    }
  };

  switch (cron) {
    case HOURLY_CRON:
      await run("reminders", () => runReminders(env, now));
      break;
    case DAILY_CRON:
      await run("purge", () => purgeExpiredEvents(env, now));
      await run("guild check", () => checkGuilds(env, now));
      break;
    case DAILY_MESSAGE_CHECK_CRON:
      await run("announcement check", () => checkAnnouncements(env, now));
      break;
    default:
      console.error(`unknown cron: ${cron}`);
  }
}
