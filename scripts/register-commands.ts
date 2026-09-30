// スラッシュコマンドを Discord に登録する（Worker のデプロイとは別に、コマンドを変えたら実行する）。
//
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
//   DISCORD_GUILD_ID を付けると、そのサーバーにだけ即時登録する（開発用）。

import { COMMANDS } from "../src/commands";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!appId || !token) {
  console.error("DISCORD_APPLICATION_ID と DISCORD_BOT_TOKEN を環境変数で指定してください。");
  process.exit(1);
}

const path = guildId
  ? `/applications/${appId}/guilds/${guildId}/commands`
  : `/applications/${appId}/commands`;

const res = await fetch(`https://discord.com/api/v10${path}`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
});
if (!res.ok) {
  console.error(`登録に失敗しました: ${res.status}`, await res.text());
  process.exit(1);
}
const registered = (await res.json()) as { name: string }[];
console.log(`${guildId ? `サーバー ${guildId}` : "グローバル"}に登録しました: ${registered.map((c) => `/${c.name}`).join(", ")}`);
