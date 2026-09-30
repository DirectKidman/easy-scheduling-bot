import { purgeEventsBefore } from "../db/queries";
import { retentionDays, type Env } from "../env";
import { logError } from "../interaction";

export const HOURLY_CRON = "0 * * * *";
export const DAILY_CRON = "7 18 * * *";

const DAY = 24 * 60 * 60;

/** 時間経過の削除: 開始日時から保持期間を過ぎたイベントと回答を物理削除する（冪等） */
export async function purgeExpiredEvents(env: Env, now: number): Promise<number> {
  const cutoff = now - retentionDays(env) * DAY;
  const deleted = await purgeEventsBefore(env.DB, cutoff);
  console.log(`purge: deleted ${deleted} events`);
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

  if (cron === DAILY_CRON) {
    await run("purge", () => purgeExpiredEvents(env, now));
  }
}
