-- 日時はすべて UTC の UNIX 秒で保存する。
-- サーバーのタイムゾーンは入力の解釈にだけ使う。

CREATE TABLE servers (
  guild_id              TEXT    PRIMARY KEY,
  announce_channel_id   TEXT    NOT NULL,
  operator_role_id      TEXT,
  timezone              TEXT    NOT NULL,
  deletion_scheduled_at INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL REFERENCES servers (guild_id) ON DELETE CASCADE,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  title      TEXT    NOT NULL,
  start_at   INTEGER NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'scheduled'
                     CHECK (state IN ('scheduled', 'cancelled', 'message_deleted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX events_guild_id ON events (guild_id);
CREATE INDEX events_start_at ON events (start_at);

CREATE TABLE responses (
  event_id   INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX responses_user_id ON responses (user_id);
