-- 投票メッセージの描き直しをまとめるための印。
-- 回答のたびに描き直すと、大勢が同時に押したとき Discord の書き込み制限にかかるので、
-- 描き直しの担当を 1 つの処理に決め、その間に入った回答はまとめて反映する。
-- vote_seq:        回答が保存されるたびに 1 増やす（描き直しの後に、新しい回答が入ったかを見分ける）
-- refresh_lock_at: 描き直しの担当が決まった時刻（UNIX 秒）。NULL なら担当なし。一定時間たてば取り直せる
ALTER TABLE polls ADD COLUMN vote_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE polls ADD COLUMN refresh_lock_at INTEGER;
