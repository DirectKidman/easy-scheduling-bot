export interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  RETENTION_DAYS?: string;
  GUILD_GRACE_DAYS?: string;
  SUBREQUEST_BUDGET?: string;
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** イベントと回答を、開始日時から何日保持するか */
export function retentionDays(env: Env): number {
  return positive(env.RETENTION_DAYS, 30);
}

/** bot が外されたと判定してから、サーバーのデータを消すまでの猶予日数 */
export function guildGraceDays(env: Env): number {
  return positive(env.GUILD_GRACE_DAYS, 14);
}

/** 定期ジョブ 1 回あたりに使ってよい Discord API 呼び出し数（Workers のサブリクエスト上限より少なく） */
export function subrequestBudget(env: Env): number {
  return positive(env.SUBREQUEST_BUDGET, 40);
}
