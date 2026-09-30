-- 日程調整（候補日の投票）と、予定の重なり判定のための所要時間

-- イベントの所要時間（分）。重なりの判定と終了時刻の表示に使う
ALTER TABLE events ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 120;

CREATE TABLE polls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT    NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  channel_id       TEXT    NOT NULL,
  message_id       TEXT,
  title            TEXT    NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 120,
  state            TEXT    NOT NULL DEFAULT 'open'
                           CHECK (state IN ('open', 'cancelled', 'message_deleted')),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX polls_guild_id ON polls (guild_id);

CREATE TABLE poll_candidates (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id  INTEGER NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  start_at INTEGER NOT NULL
);

CREATE INDEX poll_candidates_poll_id ON poll_candidates (poll_id);

-- 候補日ごとの回答。行がなければ ❌（行けない／未回答）
CREATE TABLE poll_votes (
  candidate_id INTEGER NOT NULL REFERENCES poll_candidates (id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL,
  value        TEXT    NOT NULL CHECK (value IN ('yes', 'maybe')),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, user_id)
);

CREATE INDEX poll_votes_user_id ON poll_votes (user_id);
