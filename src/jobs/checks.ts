import { announcementExists } from "../announcement";
import {
  deleteServer,
  listEventsToCheck,
  listServersToCheck,
  markEventChecked,
  markServerChecked,
} from "../db/queries";
import { DiscordErrorCode, discordRequest, isDiscordError } from "../discord/rest";
import { guildGraceDays, subrequestBudget, type Env } from "../env";
import { logError } from "../interaction";

const DAY = 24 * 60 * 60;

// 1 回のジョブで確認する件数は、Workers のサブリクエスト数の上限に収めるため subrequestBudget まで。
// 最後に確認した時刻が古い順に確認するので、件数が多くても数日かけて一巡する。

export interface GuildCheckStats {
  reachable: number;
  marked: number;
  deleted: number;
  errors: number;
}

/**
 * bot 外しの確認。各サーバーに REST で問い合わせ、
 * - 到達できれば削除予定の印を外す（一時的な障害による誤検知対策）
 * - 到達できなければ削除予定の印を付け、猶予期間を過ぎていれば設定・イベント・回答を物理削除する
 * - それ以外のエラー（Discord 側の障害など）では何も変えない
 */
export async function checkGuilds(env: Env, now: number): Promise<GuildCheckStats> {
  const stats: GuildCheckStats = { reachable: 0, marked: 0, deleted: 0, errors: 0 };
  const servers = await listServersToCheck(env.DB, subrequestBudget(env));

  for (const server of servers) {
    try {
      await discordRequest(env, "GET", `/guilds/${server.guild_id}`);
      await markServerChecked(env.DB, server.guild_id, now, null);
      stats.reachable++;
    } catch (err) {
      if (!isDiscordError(err, DiscordErrorCode.UnknownGuild, DiscordErrorCode.MissingAccess)) {
        logError("guild check failed", err);
        await markServerChecked(env.DB, server.guild_id, now, undefined);
        stats.errors++;
        continue;
      }
      if (server.deletion_scheduled_at === null) {
        await markServerChecked(env.DB, server.guild_id, now, now + guildGraceDays(env) * DAY);
        stats.marked++;
      } else if (server.deletion_scheduled_at <= now) {
        await deleteServer(env.DB, server.guild_id);
        stats.deleted++;
      } else {
        await markServerChecked(env.DB, server.guild_id, now, undefined);
      }
    }
  }
  console.log(
    `guild check: reachable ${stats.reachable}, marked ${stats.marked}, deleted ${stats.deleted}, errors ${stats.errors}`,
  );
  return stats;
}

/** 告知メッセージの存在確認。消されていたらイベントを message_deleted にする（/my やリマインドの対象から外れる）。 */
export async function checkAnnouncements(env: Env, now: number): Promise<{ missing: number; errors: number }> {
  let missing = 0;
  let errors = 0;
  const events = await listEventsToCheck(env.DB, now, subrequestBudget(env));
  for (const event of events) {
    try {
      if (!(await announcementExists(env, event))) missing++;
    } catch (err) {
      logError("announcement check failed", err);
      errors++;
    }
    await markEventChecked(env.DB, event.id, now);
  }
  console.log(`announcement check: checked ${events.length}, missing ${missing}, errors ${errors}`);
  return { missing, errors };
}
