import { ensureServerStatement } from "./queries";

export type PollState = "open" | "cancelled" | "message_deleted";
/** yes = ⭕（参加できる）/ maybe = 🔺（たぶん）/ no = ❌（参加できない）。行がなければ ➖（未回答） */
export type VoteValue = "yes" | "maybe" | "no";

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
  /** その候補に最初に回答した時刻 */
  created_at: number;
  updated_at: number;
}

const POLL_COLUMNS = "id, guild_id, channel_id, message_id, title, duration_minutes, state";

export function getPoll(db: D1Database, id: number): Promise<PollRow | null> {
  return db.prepare(`SELECT ${POLL_COLUMNS} FROM polls WHERE id = ?1`).bind(id).first<PollRow>();
}

/**
 * 日程調整と候補日をまとめて作る。サーバーの行がなければ既定値で作る。
 * すべて 1 つの batch（トランザクション）で行う（DB との往復 1 回）。候補日は直前に作った日程調整に付ける。
 */
export async function insertPoll(
  db: D1Database,
  p: Pick<PollRow, "guild_id" | "channel_id" | "title" | "duration_minutes">,
  candidates: number[],
): Promise<{ poll: PollRow; candidates: CandidateRow[] }> {
  const insertCandidate = db.prepare(
    `INSERT INTO poll_candidates (poll_id, position, start_at)
     VALUES ((SELECT MAX(id) FROM polls), ?1, ?2) RETURNING id, poll_id, position, start_at`,
  );
  const [, inserted, ...rows] = await db.batch([
    ensureServerStatement(db, p.guild_id, p.channel_id),
    db
      .prepare(
        `INSERT INTO polls (guild_id, channel_id, title, duration_minutes)
         VALUES (?1, ?2, ?3, ?4) RETURNING ${POLL_COLUMNS}`,
      )
      .bind(p.guild_id, p.channel_id, p.title, p.duration_minutes),
    ...candidates.map((start, i) => insertCandidate.bind(i + 1, start)),
  ]);
  const poll = inserted?.results[0] as PollRow | undefined;
  if (!poll) throw new Error("insertPoll returned no row");
  return { poll, candidates: rows.map((r) => r.results[0] as CandidateRow) };
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
      `SELECT v.candidate_id, v.user_id, v.value, v.created_at, v.updated_at
       FROM poll_votes v JOIN poll_candidates c ON c.id = v.candidate_id
       WHERE c.poll_id = ?1 ORDER BY v.created_at, v.user_id`,
    )
    .bind(pollId)
    .all<VoteRow>();
  return res.results;
}

/** 投票メッセージの描き直しの担当を、この秒数たっても手放していなければ、他の処理が取り直せる */
export const REFRESH_LOCK_SECONDS = 60;

/**
 * 1 つの候補日への回答を保存する。value が null なら回答を消して「➖（未回答）」に戻す。
 * clickedAt（押した時刻・ミリ秒）が、同じ候補日・ユーザーで最後に保存したものより古ければ何もしない
 * （すばやく続けて押したとき、保存の順番が前後しても最後に押したものを残すため）。
 * 保存した場合は、日程調整の vote_seq を進め、投票メッセージの描き直しの担当が空いていれば取る。
 * ここまでを 1 つの batch（トランザクション）で行う（DB との往復 1 回）。
 * applied: 保存したか / refresher: 描き直しの担当になったか（なれなければ、今の担当がこの回答も反映する）
 */
export async function setVote(
  db: D1Database,
  vote: { pollId: number; candidateId: number; userId: string; value: VoteValue | null; clickedAt: number },
  now: number,
): Promise<{ applied: boolean; refresher: boolean }> {
  const { pollId, candidateId, userId, value, clickedAt } = vote;
  const latest = `EXISTS (SELECT 1 FROM poll_vote_clicks WHERE candidate_id = ?1 AND user_id = ?2 AND clicked_at = ?3)`;
  const [click, , , lock] = await db.batch([
    db
      .prepare(
        `INSERT INTO poll_vote_clicks (candidate_id, user_id, clicked_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (candidate_id, user_id) DO UPDATE SET clicked_at = excluded.clicked_at
         WHERE excluded.clicked_at >= poll_vote_clicks.clicked_at`,
      )
      .bind(candidateId, userId, clickedAt),
    value === null
      ? db
          .prepare(`DELETE FROM poll_votes WHERE candidate_id = ?1 AND user_id = ?2 AND ${latest}`)
          .bind(candidateId, userId, clickedAt)
      : db
          .prepare(
            `INSERT INTO poll_votes (candidate_id, user_id, value, created_at, updated_at)
             SELECT ?1, ?2, ?4, ?5, ?5 WHERE ${latest}
             ON CONFLICT (candidate_id, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(candidateId, userId, clickedAt, value, now),
    db
      .prepare(`UPDATE polls SET vote_seq = vote_seq + 1 WHERE id = ?4 AND ${latest}`)
      .bind(candidateId, userId, clickedAt, pollId),
    db
      .prepare(
        `UPDATE polls SET refresh_lock_at = ?5
         WHERE id = ?4 AND (refresh_lock_at IS NULL OR refresh_lock_at <= ?5 - ?6) AND ${latest}`,
      )
      .bind(candidateId, userId, clickedAt, pollId, now, REFRESH_LOCK_SECONDS),
  ]);
  const applied = (click?.meta.changes ?? 0) > 0;
  return { applied, refresher: applied && (lock?.meta.changes ?? 0) > 0 };
}

/** 描き直し用に、日程調整・候補日・回答と vote_seq を 1 つの batch で読む（読み込みの間に回答が入っても食い違わない） */
export async function readPollForRefresh(
  db: D1Database,
  pollId: number,
): Promise<{ poll: PollRow; seq: number; candidates: CandidateRow[]; votes: VoteRow[] } | null> {
  const [poll, candidates, votes] = await db.batch([
    db.prepare(`SELECT ${POLL_COLUMNS}, vote_seq FROM polls WHERE id = ?1`).bind(pollId),
    db.prepare(`SELECT id, poll_id, position, start_at FROM poll_candidates WHERE poll_id = ?1 ORDER BY position`).bind(pollId),
    db
      .prepare(
        `SELECT v.candidate_id, v.user_id, v.value, v.created_at, v.updated_at
         FROM poll_votes v JOIN poll_candidates c ON c.id = v.candidate_id
         WHERE c.poll_id = ?1 ORDER BY v.created_at, v.user_id`,
      )
      .bind(pollId),
  ]);
  const row = (poll?.results[0] ?? null) as (PollRow & { vote_seq: number }) | null;
  if (!row) return null;
  const { vote_seq, ...rest } = row;
  return {
    poll: rest,
    seq: vote_seq,
    candidates: candidates!.results as CandidateRow[],
    votes: votes!.results as VoteRow[],
  };
}

/**
 * 描き直しの担当を手放す。seq を渡したときは、その後に回答が入っていなければ（vote_seq が同じなら）だけ手放す。
 * 手放せたら true。false なら新しい回答があるので、もう一度描き直す。
 */
export async function releasePollRefresh(db: D1Database, pollId: number, seq: number | null): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE polls SET refresh_lock_at = NULL WHERE id = ?1 AND (?2 IS NULL OR vote_seq = ?2)`)
    .bind(pollId, seq)
    .run();
  return res.meta.changes > 0;
}

/**
 * 確定: 選ばれた候補日ごとにイベントを作り、その候補の回答を引き継いで（⭕→参加、🔺→未定、❌→不参加）、
 * 日程調整（候補・投票）は物理削除する。イベントの告知メッセージは候補ごとに指定する。
 * D1 の batch は 1 トランザクションなので、同時に確定されてもイベントは二重にできない。
 * すでに確定・中止されていれば null。戻り値のイベント ID は picks と同じ順。
 */
export async function confirmPoll(
  db: D1Database,
  poll: PollRow,
  picks: { candidate: CandidateRow; messageId: string | null }[],
  now: number,
): Promise<number[] | null> {
  const stillOpen = `EXISTS (SELECT 1 FROM polls WHERE id = ?1 AND state = 'open')`;
  const statements = picks.flatMap(({ candidate, messageId }) => [
    db
      .prepare(
        `INSERT INTO events (guild_id, channel_id, message_id, title, start_at, duration_minutes)
         SELECT ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${stillOpen} RETURNING id`,
      )
      .bind(poll.id, poll.guild_id, poll.channel_id, messageId, poll.title, candidate.start_at, poll.duration_minutes),
    db
      .prepare(
        `INSERT INTO responses (event_id, user_id, status, updated_at)
         SELECT (SELECT MAX(id) FROM events), user_id, CASE value WHEN 'yes' THEN 'going' WHEN 'maybe' THEN 'maybe' ELSE 'declined' END, ?3
         FROM poll_votes WHERE candidate_id = ?2 AND ${stillOpen}`,
      )
      .bind(poll.id, candidate.id, now),
  ]);
  statements.push(db.prepare(`DELETE FROM polls WHERE id = ?1 AND state = 'open'`).bind(poll.id));
  const results = await db.batch<{ id: number }>(statements);
  const ids = picks.map((_, i) => results[i * 2]?.results[0]?.id);
  return ids.every((id) => id !== undefined) ? (ids as number[]) : null;
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
  /** その日程調整のサーバーのタイムゾーン（表示用） */
  timezone: string;
}

/** ユーザーが回答している、受付中の日程調整の今後の候補 */
export async function listOpenPollVotesForUser(db: D1Database, userId: string, now: number): Promise<UserPollVote[]> {
  const res = await db
    .prepare(
      `SELECT p.id AS poll_id, p.guild_id, p.channel_id, p.message_id, p.title, p.duration_minutes,
              c.id AS candidate_id, c.start_at, v.value, s.timezone
       FROM poll_votes v
       JOIN poll_candidates c ON c.id = v.candidate_id
       JOIN polls p ON p.id = c.poll_id
       JOIN servers s ON s.guild_id = p.guild_id
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
  const past = `user_id = ?1 AND candidate_id IN (SELECT id FROM poll_candidates WHERE start_at < ?2)`;
  const [res] = await db.batch([
    db.prepare(`DELETE FROM poll_votes WHERE ${past}`).bind(userId, now),
    db.prepare(`DELETE FROM poll_vote_clicks WHERE ${past}`).bind(userId, now),
  ]);
  return res!.meta.changes;
}

export async function deleteAllPollVotes(db: D1Database, userId: string): Promise<number> {
  const [res] = await db.batch([
    db.prepare(`DELETE FROM poll_votes WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM poll_vote_clicks WHERE user_id = ?1`).bind(userId),
  ]);
  return res!.meta.changes;
}
