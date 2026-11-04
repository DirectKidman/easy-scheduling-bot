-- 回答パネルのボタンを押した時刻（候補日 × ユーザーごとに最後の 1 つ）。
-- 回答はボタンへの応答の後に保存するので、すばやく続けて押すと保存の順番が前後しうる。
-- 押した時刻がこれより古い保存は捨て、最後に押したものが残るようにする。
-- 取り消し（➖）は poll_votes の行を消すので、その時刻もここで覚えておく。
CREATE TABLE poll_vote_clicks (
  candidate_id INTEGER NOT NULL REFERENCES poll_candidates (id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL,
  -- 押した時刻（UNIX ミリ秒。インタラクション ID から取る）
  clicked_at   INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, user_id)
);

CREATE INDEX poll_vote_clicks_user_id ON poll_vote_clicks (user_id);
