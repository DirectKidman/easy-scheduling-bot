export type PollState = "open" | "cancelled" | "message_deleted";
export type VoteValue = "yes" | "maybe";

export interface PollRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  duration_minutes: number;
  state: PollState;
}

export interface CandidateRow {
  id: number;
  poll_id: number;
  position: number;
  start_at: number;
}

export interface VoteRow {
  candidate_id: number;
  user_id: string;
  value: VoteValue;
  updated_at: number;
}

const POLL_COLUMNS = "id, guild_id, channel_id, message_id, title, duration_minutes, state";

export function getPoll(db: D1Database, id: number): Promise<PollRow | null> {
  return db.prepare(`SELECT ${POLL_COLUMNS} FROM polls WHERE id = ?1`).bind(id).first<PollRow>();
}

/** 日程調整と候補日をまとめて作る */
export async function insertPoll(
  db: D1Database,
  p: Pick<PollRow, "guild_id" | "channel_id" | "title" | "duration_minutes">,
  candidates: number[],
): Promise<{ poll: PollRow; candidates: CandidateRow[] }> {
  const row = await db
    .prepare(
      `INSERT INTO polls (guild_id, channel_id, title, duration_minutes)
       VALUES (?1, ?2, ?3, ?4) RETURNING ${POLL_COLUMNS}`,
    )
    .bind(p.guild_id, p.channel_id, p.title, p.duration_minutes)
    .first<PollRow>();
  if (!row) throw new Error("insertPoll returned no row");
  const insert = db.prepare(
    `INSERT INTO poll_candidates (poll_id, position, start_at) VALUES (?1, ?2, ?3) RETURNING id, poll_id, position, start_at`,
  );
  const results = await db.batch<CandidateRow>(candidates.map((start, i) => insert.bind(row.id, i + 1, start)));
  return { poll: row, candidates: results.map((r) => r.results[0]!) };
}

export async function setPollMessage(db: D1Database, id: number, messageId: string): Promise<void> {
  await db.prepare(`UPDATE polls SET message_id = ?2 WHERE id = ?1`).bind(id, messageId).run();
}

export async function deletePoll(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM polls WHERE id = ?1`).bind(id).run();
}

export async function transitionPollState(db: D1Database, id: number, from: PollState, to: PollState): Promise<boolean> {
  const res = await db.prepare(`UPDATE polls SET state = ?3 WHERE id = ?1 AND state = ?2`).bind(id, from, to).run();
  return res.meta.changes > 0;
}

export async function listCandidates(db: D1Database, pollId: number): Promise<CandidateRow[]> {
  const res = await db
    .prepare(`SELECT id, poll_id, position, start_at FROM poll_candidates WHERE poll_id = ?1 ORDER BY position`)
    .bind(pollId)
    .all<CandidateRow>();
  return res.results;
}

export async function listVotes(db: D1Database, pollId: number): Promise<VoteRow[]> {
  const res = await db
    .prepare(
      `SELECT v.candidate_id, v.user_id, v.value, v.updated_at
       FROM poll_votes v JOIN poll_candidates c ON c.id = v.candidate_id
       WHERE c.poll_id = ?1 ORDER BY v.updated_at, v.user_id`,
    )
    .bind(pollId)
    .all<VoteRow>();
  return res.results;
}

/**
 * セレクトメニューで選び直した結果を保存する。
 * value の回答を `selected` の候補だけにし、そこに入っていたもう一方の回答（⭕⇔🔺）は上書きする。
 * `editable` に含まれない候補（締め切った過去の候補など）は触らない。
 */
export async function replaceVotes(
  db: D1Database,
  userId: string,
  value: VoteValue,
  selected: number[],
  editable: number[],
  now: number,
): Promise<void> {
  const selectedSet = new Set(selected);
  const toRemove = editable.filter((id) => !selectedSet.has(id));
  const statements: D1PreparedStatement[] = [];
  if (toRemove.length > 0) {
    const placeholders = toRemove.map((_, i) => `?${i + 3}`).join(", ");
    statements.push(
      db
        .prepare(`DELETE FROM poll_votes WHERE user_id = ?1 AND value = ?2 AND candidate_id IN (${placeholders})`)
        .bind(userId, value, ...toRemove),
    );
  }
  const upsert = db.prepare(
    `INSERT INTO poll_votes (candidate_id, user_id, value, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (candidate_id, user_id) DO UPDATE SET
       value = excluded.value,
       updated_at = CASE WHEN poll_votes.value = excluded.value
                         THEN poll_votes.updated_at ELSE excluded.updated_at END`,
  );
  for (const id of selected) statements.push(upsert.bind(id, userId, value, now));
  if (statements.length > 0) await db.batch(statements);
}

/**
 * 確定: 選ばれた候補の回答を確定イベントの回答に引き継ぎ（⭕→参加、🔺→未定）、
 * 同じ告知メッセージを使うイベントを作って、日程調整（候補・投票）は物理削除する。
 * D1 の batch は 1 トランザクションなので、同時に確定されても イベントは 1 つしかできない。
 * すでに確定・中止されていれば null。
 */
export async function confirmPoll(
  db: D1Database,
  poll: PollRow,
  candidate: CandidateRow,
  now: number,
): Promise<number | null> {
  const stillOpen = `EXISTS (SELECT 1 FROM polls WHERE id = ?1 AND state = 'open')`;
  const [inserted] = await db.batch<{ id: number }>([
    db
      .prepare(
        `INSERT INTO events (guild_id, channel_id, message_id, title, start_at, duration_minutes)
         SELECT ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${stillOpen} RETURNING id`,
      )
      .bind(poll.id, poll.guild_id, poll.channel_id, poll.message_id, poll.title, candidate.start_at, poll.duration_minutes),
    db
      .prepare(
        `INSERT INTO responses (event_id, user_id, status, updated_at)
         SELECT (SELECT MAX(id) FROM events), user_id, CASE value WHEN 'yes' THEN 'going' ELSE 'maybe' END, ?3
         FROM poll_votes WHERE candidate_id = ?2 AND ${stillOpen}`,
      )
      .bind(poll.id, candidate.id, now),
    db.prepare(`DELETE FROM polls WHERE id = ?1 AND state = 'open'`).bind(poll.id),
  ]);
  return inserted?.results[0]?.id ?? null;
}

/** 最後の候補日から保持期間を過ぎた日程調整を物理削除する（候補・投票は ON DELETE CASCADE） */
export async function purgePollsBefore(db: D1Database, cutoff: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM polls WHERE id IN (
         SELECT poll_id FROM poll_candidates GROUP BY poll_id HAVING MAX(start_at) < ?1
       )`,
    )
    .bind(cutoff)
    .run();
  return res.meta.changes;
}

// ---- /my・/forget・予定の重なり ----

export interface UserPollVote {
  poll_id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  title: string;
  duration_minutes: number;
  candidate_id: number;
  start_at: number;
  value: VoteValue;
}

/** ユーザーが回答している、受付中の日程調整の今後の候補 */
export async function listOpenPollVotesForUser(db: D1Database, userId: string, now: number): Promise<UserPollVote[]> {
  const res = await db
    .prepare(
      `SELECT p.id AS poll_id, p.guild_id, p.channel_id, p.message_id, p.title, p.duration_minutes,
              c.id AS candidate_id, c.start_at, v.value
       FROM poll_votes v
       JOIN poll_candidates c ON c.id = v.candidate_id
       JOIN polls p ON p.id = c.poll_id
       WHERE v.user_id = ?1 AND p.state = 'open' AND c.start_at >= ?2
       ORDER BY c.start_at, c.id`,
    )
    .bind(userId, now)
    .all<UserPollVote>();
  return res.results;
}

export async function countPollVotesForUser(
  db: D1Database,
  userId: string,
  now: number,
): Promise<{ past: number; future: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(c.start_at < ?2), 0) AS past, COALESCE(SUM(c.start_at >= ?2), 0) AS future
       FROM poll_votes v JOIN poll_candidates c ON c.id = v.candidate_id
       WHERE v.user_id = ?1`,
    )
    .bind(userId, now)
    .first<{ past: number; future: number }>();
  return row ?? { past: 0, future: 0 };
}

export async function deletePastPollVotes(db: D1Database, userId: string, now: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM poll_votes
       WHERE user_id = ?1 AND candidate_id IN (SELECT id FROM poll_candidates WHERE start_at < ?2)`,
    )
    .bind(userId, now)
    .run();
  return res.meta.changes;
}

export async function deleteAllPollVotes(db: D1Database, userId: string): Promise<number> {
  const res = await db.prepare(`DELETE FROM poll_votes WHERE user_id = ?1`).bind(userId).run();
  return res.meta.changes;
}
