# easy-scheduling-bot

Discord の中だけでイベントの作成・参加確認・確認ができる bot。
Cloudflare Workers（HTTP インタラクション）+ D1 + Cron Triggers で動かす。TypeScript 製。

- 要件定義: [docs/requirements.md](docs/requirements.md)
- 構成と仕組み: [docs/architecture.md](docs/architecture.md)

## コマンド

| コマンド | 実行者 | 内容 |
|---|---|---|
| `/setup` | サーバー管理権限 | 告知チャンネル・運営ロール・タイムゾーン・リマインドの送り方を設定 |
| `/event` | 運営者 | モーダルでイベント（日時・所要時間）を作成し、告知メッセージを投稿 |
| `/poll` | 運営者 | 候補日を並べて日程調整。参加者は候補ごとに ⭕／🔺 で回答し、運営者が 1 日を選んで確定する |
| `/my` | 全員 | 参加・未定と回答した今後の予定と回答中の日程調整を、サーバー横断で表示（自分にだけ見える） |
| `/forget` | 全員 | 自分の回答を削除（過去分だけ／すべて。「すべて」は影響する予定を出して確認） |

告知メッセージには [✅ 参加] [🤔 未定] [❌ 不参加] [⋯ 詳細] のボタンが付く。
「詳細」からは全員の回答一覧を見られ、運営者にはイベントの中止ボタンも表示される。
✅・🤔 を押したとき、同じ時間帯に他の予定（全サーバー横断）があれば、押した本人にだけ警告を出す（回答は受け付ける）。

### 日程調整（`/poll`）

1. 運営者が `/poll` でタイトル・候補日（1 行に 1 つ、最大 20 個）・所要時間を入力すると、投票メッセージが投稿される
2. 参加者は [🗳️ 回答する] を押すと、**本人にだけ見える回答パネル**が開く。候補日ごとに、この bot で管理している本人の他の予定（別サーバーの確定イベント、別の日程調整で ⭕🔺 を付けた候補）との重なりが表示され、2 つのセレクトメニューで ⭕（行ける）／🔺（たぶん行ける）を複数選択する。選ばなかった日は ❌
3. 投票メッセージには候補ごとの ⭕🔺 の人数と名前が出て、⭕ が最多の候補に ⭐ が付く
4. 運営者が [⋯ 詳細] から確定する日を選ぶと、その日に ⭕ の人は「参加」、🔺 の人は「未定」として引き継いだ確定イベントになり、投票メッセージが告知に切り替わる（以後はリマインド・`/my` の対象）。候補ごとの投票データは削除される

予定の重なりは本人にだけ見えるメッセージでしか出さない（他のメンバーに、別サーバーでの予定を見せないため）。

## 定期ジョブ（Cron Triggers）

| Cron (UTC) | ジョブ |
|---|---|
| `0 * * * *` | リマインド。開始の約24時間前（前日）と約1〜2時間前（当日）に、参加・未定の人へ送る。DM モードでは DM を送り、届かない人は告知チャンネルでメンション |
| `7 18 * * *` | 開始から `RETENTION_DAYS` 日を過ぎたイベントと回答の削除 / bot 外しの確認（到達できないサーバーに印を付け、`GUILD_GRACE_DAYS` 日後に設定・イベント・回答を削除。再び到達できたら印を外す） |
| `37 18 * * *` | 告知メッセージの存在確認（消されていたらイベントを `/my` とリマインドの対象から外す） |

- リマインドは「送信済み」の印を先に付けてから送り、失敗したら外す。ジョブが止まっていても次回の実行で拾い直し、二重には送らない
- 1 回の実行で使う Discord API 呼び出しは `SUBREQUEST_BUDGET` 回まで（Workers のサブリクエスト上限対策）。確認ジョブは最後に確認した時刻が古い順に処理するので、件数が多い場合は数日かけて一巡する
- 数値は `wrangler.jsonc` の `vars` で変更できる

日時は `2026-10-11 19:00`、`10/11 19:00`、`10月11日 19時` のように入力し、`/setup` で設定したタイムゾーンで解釈して UTC で保存する。

## セットアップ

### 1. Discord アプリを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作成
2. **General Information** の `Application ID` と `Public Key` を控える
3. **Bot** でトークンを発行して控える。Privileged Gateway Intents（Message Content / Server Members / Presence）は**すべてオフのまま**でよい
4. **Installation** で Guild Install のみを有効にし、スコープ `bot` `applications.commands`、権限 `View Channels` `Send Messages` `Embed Links` `Read Message History` を付けたリンクでサーバーに招待する

### 2. Cloudflare にデプロイ

```sh
npm ci
npx wrangler login
npx wrangler d1 create easy-scheduling-bot   # 出力された database_id を wrangler.jsonc に書く
npm run db:migrate:remote

npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID

npm run deploy
```

デプロイ後、Developer Portal の **General Information → Interactions Endpoint URL** に Worker の URL（`https://easy-scheduling-bot.<アカウント>.workers.dev/`）を登録する。
Discord が署名付きの PING を送り、検証に通れば保存できる。

### 3. スラッシュコマンドを登録

```sh
npm run register
# .env の DISCORD_APPLICATION_ID・DISCORD_BOT_TOKEN を読む（環境変数で渡しても可。環境変数が優先）
# 開発中は DISCORD_GUILD_ID=... を付けると、そのサーバーにだけ即時反映される
```

コマンドの定義（`src/commands.ts`）を変えたら再実行する。

## 開発

```sh
npm test            # Workers ランタイム（Miniflare）+ D1 でのテスト
npm run typecheck
npm run db:migrate:local && npm run dev   # .dev.vars.example を .dev.vars にコピーして値を入れておく
```

ローカルの `wrangler dev` を Discord から叩くには、`cloudflared tunnel` などで公開 URL を作って Interactions Endpoint URL に設定する。

### 構成

```
src/
  index.ts            fetch（インタラクション）と scheduled（Cron）の入口
  verify.ts           Ed25519 署名検証
  router.ts           インタラクションの振り分け
  handlers/           /setup /event /poll /my /forget とボタン・セレクトメニューの処理
  conflicts.ts        予定の重なり（全サーバー横断）
  renderPoll.ts       投票メッセージ・回答パネルの組み立て
  announcement.ts     告知メッセージの再描画（REST）
  render.ts           告知メッセージ・名簿の組み立て
  time.ts             タイムゾーン付き日時の解釈
  db/                 D1 のクエリ（queries.ts: サーバー・イベント・回答 / polls.ts: 日程調整）
  jobs/               定期ジョブ（リマインド、削除、到達確認）
  discord/            REST クライアントと権限判定
migrations/           D1 のマイグレーション
scripts/              コマンド登録スクリプト
test/                 テスト
```

### 設計メモ

- 状態はすべて D1 に置く。ボタンの `custom_id` は `rsvp:<イベントID>:<回答>` のようにイベント ID と操作を埋め込み、押されるたびに DB を見て処理する
- 回答ボタンは、押されたメッセージそのものをインタラクションの応答（`UPDATE_MESSAGE`）で書き換える。REST の投稿レート制限を消費せず、毎回 DB 全体から再生成するので連打しても食い違わない
- 場所・説明は DB に保存せず、告知メッセージの埋め込みにだけ持つ。再描画時はメッセージ側の本文を引き継ぐ
- 重い処理（投稿、`/my` のサーバー名取得）は先に「処理中」を返し、`waitUntil` で後から結果を書き込む
- 権限はコマンドの `default_member_permissions` に頼らず、コマンド・モーダル送信・ボタン押下のたびに bot 側で確認する
- ログにはイベント内容・回答内容を出さない（エラーの種類と API のパス・コードだけ）

## ブランチ運用

| ブランチ | 用途 |
|---|---|
| `main` | リリース済みの安定版 |
| `develop` | 開発の統合先 |
| `feature/**` | 機能ごとの作業ブランチ（`develop` から切り、`develop` へマージ） |
