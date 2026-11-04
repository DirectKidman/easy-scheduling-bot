-- 日程調整の回答に ×（参加できない）を追加し、表の列（メンバー）の並びを固定するための回答時刻を持たせる。
-- poll_votes は他のテーブルから参照されていないので、作り直しても他のデータには影響しない。

CREATE TABLE poll_votes_new (
  candidate_id INTEGER NOT NULL REFERENCES poll_candidates (id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL,
  -- yes = 〇（参加できる）/ maybe = △（たぶん）/ no = ×（参加できない）。行がなければ －（未回答）
  value        TEXT    NOT NULL CHECK (value IN ('yes', 'maybe', 'no')),
  -- その候補に最初に回答した時刻（表のメンバーの並び順に使う。回答を変えても変わらない）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, user_id)
);

INSERT INTO poll_votes_new (candidate_id, user_id, value, created_at, updated_at)
  SELECT candidate_id, user_id, value, updated_at, updated_at FROM poll_votes;

DROP TABLE poll_votes;
ALTER TABLE poll_votes_new RENAME TO poll_votes;
CREATE INDEX poll_votes_user_id ON poll_votes (user_id);

-- servers.announce_channel_id は使わなくなった（告知はコマンドを実行したチャンネルに出す）。
-- 列の削除はデプロイとマイグレーションの順番によって旧コードを壊すので、残したままにする。
