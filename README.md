# easy-scheduling-bot

Discord の中だけでイベントの作成・参加確認・確認ができる bot。
Cloudflare Workers（HTTP インタラクション）+ D1 + Cron Triggers で動かす。

- 要件定義: [docs/requirements.md](docs/requirements.md)

## ブランチ運用

| ブランチ | 用途 |
|---|---|
| `main` | リリース済みの安定版 |
| `develop` | 開発の統合先 |
| `feature/**` | 機能ごとの作業ブランチ（`develop` から切り、`develop` へマージ） |
