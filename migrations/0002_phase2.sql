-- フェーズ2: リマインド、bot 外しの確認、告知メッセージの存在確認

-- リマインドの送り方: 'channel'（告知チャンネルでメンション）/ 'dm'（DM。届かない人はチャンネルでメンション）
ALTER TABLE servers ADD COLUMN reminder_mode TEXT NOT NULL DEFAULT 'channel'
  CHECK (reminder_mode IN ('channel', 'dm'));
-- bot 外しの確認ジョブで最後に確認した時刻（古い順に少しずつ確認する）
ALTER TABLE servers ADD COLUMN checked_at INTEGER;

-- リマインドの送信済み印（NULL = 未送信）。先に印を付けてから送り、失敗したら外す
ALTER TABLE events ADD COLUMN reminded_day_before_at INTEGER;
ALTER TABLE events ADD COLUMN reminded_day_of_at INTEGER;
-- 告知メッセージの存在確認ジョブで最後に確認した時刻
ALTER TABLE events ADD COLUMN checked_at INTEGER;

CREATE INDEX events_state_start_at ON events (state, start_at);
