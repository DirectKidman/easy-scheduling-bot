export type RsvpStatus = "going" | "maybe" | "declined";
export type EventState = "scheduled" | "cancelled" | "message_deleted";

export interface ServerRow {
  guild_id: string;
  announce_channel_id: string;
  operator_role_id: string | null;
  timezone: string;
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
      `SELECT guild_id, announce_channel_id, operator_role_id, timezone, deletion_scheduled_at
       FROM servers WHERE guild_id = ?1`,
    )
    .bind(guildId)
    .first<ServerRow>();
}

export async function upsertServer(
  db: D1Database,
  s: Pick<ServerRow, "guild_id" | "announce_channel_id" | "operator_role_id" | "timezone">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO servers (guild_id, announce_channel_id, operator_role_id, timezone)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (guild_id) DO UPDATE SET
         announce_channel_id = excluded.announce_channel_id,
         operator_role_id    = excluded.operator_role_id,
         timezone            = excluded.timezone,
         deletion_scheduled_at = NULL,
         updated_at          = unixepoch()`,
    )
    .bind(s.guild_id, s.announce_channel_id, s.operator_role_id, s.timezone)
    .run();
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
