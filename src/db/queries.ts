export type RsvpStatus = "going" | "maybe" | "declined";
export type EventState = "scheduled" | "cancelled" | "message_deleted";
export type ReminderMode = "channel" | "dm";

export interface ServerRow {
  guild_id: string;
  announce_channel_id: string;
  operator_role_id: string | null;
  timezone: string;
  reminder_mode: ReminderMode;
  deletion_scheduled_at: number | null;
}

export interface EventRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  start_at: number;
  state: EventState;
}

export interface ResponseRow {
  user_id: string;
  status: RsvpStatus;
  updated_at: number;
}

// ---- servers ----

export function getServer(db: D1Database, guildId: string): Promise<ServerRow | null> {
  return db
    .prepare(
      `SELECT guild_id, announce_channel_id, operator_role_id, timezone, reminder_mode, deletion_scheduled_at
       FROM servers WHERE guild_id = ?1`,
    )
    .bind(guildId)
    .first<ServerRow>();
}

export async function upsertServer(
  db: D1Database,
  s: Pick<ServerRow, "guild_id" | "announce_channel_id" | "operator_role_id" | "timezone" | "reminder_mode">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO servers (guild_id, announce_channel_id, operator_role_id, timezone, reminder_mode)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (guild_id) DO UPDATE SET
         announce_channel_id = excluded.announce_channel_id,
         operator_role_id    = excluded.operator_role_id,
         timezone            = excluded.timezone,
         reminder_mode       = excluded.reminder_mode,
         deletion_scheduled_at = NULL,
         updated_at          = unixepoch()`,
    )
    .bind(s.guild_id, s.announce_channel_id, s.operator_role_id, s.timezone, s.reminder_mode)
    .run();
}

/** bot 外しの確認対象: 最後に確認してから時間が経った順 */
export async function listServersToCheck(
  db: D1Database,
  limit: number,
): Promise<Pick<ServerRow, "guild_id" | "deletion_scheduled_at">[]> {
  const res = await db
    .prepare(
      `SELECT guild_id, deletion_scheduled_at FROM servers
       ORDER BY checked_at IS NOT NULL, checked_at, guild_id LIMIT ?1`,
    )
    .bind(limit)
    .all<Pick<ServerRow, "guild_id" | "deletion_scheduled_at">>();
  return res.results;
}

/** 到達確認の結果を記録する。deletionAt が null なら削除予定の印を外す */
export async function markServerChecked(
  db: D1Database,
  guildId: string,
  now: number,
  deletionAt: number | null | undefined,
): Promise<void> {
  if (deletionAt === undefined) {
    await db.prepare(`UPDATE servers SET checked_at = ?2 WHERE guild_id = ?1`).bind(guildId, now).run();
  } else {
    await db
      .prepare(`UPDATE servers SET checked_at = ?2, deletion_scheduled_at = ?3 WHERE guild_id = ?1`)
      .bind(guildId, now, deletionAt)
      .run();
  }
}

/** サーバーの設定・イベント・回答を物理削除する（イベントと回答は ON DELETE CASCADE） */
export async function deleteServer(db: D1Database, guildId: string): Promise<void> {
  await db.prepare(`DELETE FROM servers WHERE guild_id = ?1`).bind(guildId).run();
}

// ---- events ----

const EVENT_COLUMNS = "id, guild_id, channel_id, message_id, title, start_at, state";

export function getEvent(db: D1Database, id: number): Promise<EventRow | null> {
  return db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?1`).bind(id).first<EventRow>();
}

export async function insertEvent(
  db: D1Database,
  e: Pick<EventRow, "guild_id" | "channel_id" | "title" | "start_at">,
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO events (guild_id, channel_id, title, start_at)
       VALUES (?1, ?2, ?3, ?4) RETURNING id`,
    )
    .bind(e.guild_id, e.channel_id, e.title, e.start_at)
    .first<{ id: number }>();
  if (!row) throw new Error("insertEvent returned no row");
  return row.id;
}

export async function setEventMessage(db: D1Database, id: number, messageId: string): Promise<void> {
  await db.prepare(`UPDATE events SET message_id = ?2 WHERE id = ?1`).bind(id, messageId).run();
}

export async function deleteEvent(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM events WHERE id = ?1`).bind(id).run();
}

/** 予定中のイベントの状態を変える。変わった場合に true（二重操作の検出用）。 */
export async function transitionEventState(
  db: D1Database,
  id: number,
  from: EventState,
  to: EventState,
): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE events SET state = ?3 WHERE id = ?1 AND state = ?2`)
    .bind(id, from, to)
    .run();
  return res.meta.changes > 0;
}

/** 告知メッセージの存在確認の対象: 今後の予定で、最後に確認してから時間が経った順 */
export async function listEventsToCheck(db: D1Database, now: number, limit: number): Promise<EventRow[]> {
  const res = await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE state = 'scheduled' AND message_id IS NOT NULL AND start_at >= ?1
       ORDER BY checked_at IS NOT NULL, checked_at, id LIMIT ?2`,
    )
    .bind(now, limit)
    .all<EventRow>();
  return res.results;
}

export async function markEventChecked(db: D1Database, id: number, now: number): Promise<void> {
  await db.prepare(`UPDATE events SET checked_at = ?2 WHERE id = ?1`).bind(id, now).run();
}

export type ReminderKind = "day_before" | "day_of";

export interface ReminderCandidate extends EventRow {
  created_at: number;
  reminded_day_before_at: number | null;
  reminded_day_of_at: number | null;
  reminder_mode: ReminderMode;
}

/** リマインドの候補: 24 時間以内に始まり、どちらかのリマインドが未送信のイベント */
export async function listReminderCandidates(
  db: D1Database,
  now: number,
  horizon: number,
  limit: number,
): Promise<ReminderCandidate[]> {
  const res = await db
    .prepare(
      `SELECT e.id, e.guild_id, e.channel_id, e.message_id, e.title, e.start_at, e.state, e.created_at,
              e.reminded_day_before_at, e.reminded_day_of_at, s.reminder_mode
       FROM events e JOIN servers s ON s.guild_id = e.guild_id
       WHERE e.state = 'scheduled' AND e.message_id IS NOT NULL
         AND e.start_at > ?1 AND e.start_at <= ?2
         AND (e.reminded_day_before_at IS NULL OR e.reminded_day_of_at IS NULL)
       ORDER BY e.start_at, e.id LIMIT ?3`,
    )
    .bind(now, now + horizon, limit)
    .all<ReminderCandidate>();
  return res.results;
}

const REMINDER_COLUMN: Record<ReminderKind, string> = {
  day_before: "reminded_day_before_at",
  day_of: "reminded_day_of_at",
};

/**
 * 送信済みの印を付ける。まだ付いていなかった場合だけ true（＝このジョブが送る権利を得た）。
 * 同じジョブが重なって動いても、二重には送らない。
 */
export async function claimReminder(db: D1Database, id: number, kind: ReminderKind, now: number): Promise<boolean> {
  const col = REMINDER_COLUMN[kind];
  const res = await db
    .prepare(`UPDATE events SET ${col} = ?2 WHERE id = ?1 AND ${col} IS NULL`)
    .bind(id, now)
    .run();
  return res.meta.changes > 0;
}

/** 送信に失敗したので印を外し、次回のジョブで拾い直させる */
export async function releaseReminder(db: D1Database, id: number, kind: ReminderKind, claimedAt: number): Promise<void> {
  const col = REMINDER_COLUMN[kind];
  await db.prepare(`UPDATE events SET ${col} = NULL WHERE id = ?1 AND ${col} = ?2`).bind(id, claimedAt).run();
}

/** 開始日時が cutoff より前のイベントを物理削除する（回答は ON DELETE CASCADE で消える）。 */
export async function purgeEventsBefore(db: D1Database, cutoff: number): Promise<number> {
  const res = await db.prepare(`DELETE FROM events WHERE start_at < ?1`).bind(cutoff).run();
  return res.meta.changes;
}

// ---- responses ----

export async function upsertResponse(
  db: D1Database,
  eventId: number,
  userId: string,
  status: RsvpStatus,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO responses (event_id, user_id, status, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         status = excluded.status,
         updated_at = CASE WHEN responses.status = excluded.status
                           THEN responses.updated_at ELSE excluded.updated_at END`,
    )
    .bind(eventId, userId, status, now)
    .run();
}

/** 回答を、回答した順（最初に今の状態にした時刻順）で返す */
export async function listResponses(db: D1Database, eventId: number): Promise<ResponseRow[]> {
  const res = await db
    .prepare(
      `SELECT user_id, status, updated_at FROM responses
       WHERE event_id = ?1 ORDER BY updated_at, user_id`,
    )
    .bind(eventId)
    .all<ResponseRow>();
  return res.results;
}

export interface UpcomingRow {
  event_id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  start_at: number;
  status: RsvpStatus;
}

/** /my 用: 全サーバー横断で、ユーザーが回答した今後の予定 */
export async function listUpcomingForUser(
  db: D1Database,
  userId: string,
  now: number,
  statuses: RsvpStatus[],
): Promise<UpcomingRow[]> {
  const placeholders = statuses.map((_, i) => `?${i + 3}`).join(", ");
  const res = await db
    .prepare(
      `SELECT e.id AS event_id, e.guild_id, e.channel_id, e.message_id, e.title, e.start_at, r.status
       FROM responses r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ?1 AND e.start_at >= ?2 AND e.state = 'scheduled'
         AND r.status IN (${placeholders})
       ORDER BY e.start_at, e.id`,
    )
    .bind(userId, now, ...statuses)
    .all<UpcomingRow>();
  return res.results;
}

/** /forget 用: ユーザーが回答している今後の予定（進行中を含む、中止・消滅以外） */
export async function listFutureEventsForUser(db: D1Database, userId: string, now: number): Promise<UpcomingRow[]> {
  const res = await db
    .prepare(
      `SELECT e.id AS event_id, e.guild_id, e.channel_id, e.message_id, e.title, e.start_at, r.status
       FROM responses r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ?1 AND e.start_at >= ?2 AND e.state = 'scheduled'
       ORDER BY e.start_at, e.id`,
    )
    .bind(userId, now)
    .all<UpcomingRow>();
  return res.results;
}

export async function countResponsesForUser(
  db: D1Database,
  userId: string,
  now: number,
): Promise<{ past: number; future: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(e.start_at < ?2), 0) AS past, COALESCE(SUM(e.start_at >= ?2), 0) AS future
       FROM responses r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ?1`,
    )
    .bind(userId, now)
    .first<{ past: number; future: number }>();
  return row ?? { past: 0, future: 0 };
}

/** 終了済み（開始日時が過ぎた）イベントへの回答を削除する */
export async function deletePastResponses(db: D1Database, userId: string, now: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM responses
       WHERE user_id = ?1 AND event_id IN (SELECT id FROM events WHERE start_at < ?2)`,
    )
    .bind(userId, now)
    .run();
  return res.meta.changes;
}

/** 全サーバー分の回答を削除する */
export async function deleteAllResponses(db: D1Database, userId: string): Promise<number> {
  const res = await db.prepare(`DELETE FROM responses WHERE user_id = ?1`).bind(userId).run();
  return res.meta.changes;
}
