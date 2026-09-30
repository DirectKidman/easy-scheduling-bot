import type { APIChatInputApplicationCommandGuildInteraction, APIGuild, APIInteractionResponse } from "discord-api-types/v10";
import { listUpcomingForUser } from "../db/queries";
import { discordRequest } from "../discord/rest";
import { defer, logError, type Context } from "../interaction";
import { escapeMarkdown, messageLink, STATUS_META } from "../render";

/** 一度に表示する最大件数 */
const MAX_ITEMS = 20;

export function handleMy(
  ctx: Context,
  interaction: APIChatInputApplicationCommandGuildInteraction,
): APIInteractionResponse {
  const userId = interaction.member.user.id;
  return defer(ctx, interaction.token, "message", async () => {
    const rows = await listUpcomingForUser(ctx.env.DB, userId, ctx.now, ["going", "maybe"]);
    if (rows.length === 0) {
      return { content: "📋 参加・未定と回答した今後の予定はありません。" };
    }
    const shown = rows.slice(0, MAX_ITEMS);

    // サーバー名は保存せず、表示のたびに取得する（取得できなければ ID の代わりに伏せて表示）
    const guildIds = [...new Set(shown.map((r) => r.guild_id))];
    const names = new Map<string, string>();
    await Promise.all(
      guildIds.map(async (id) => {
        try {
          const guild = await discordRequest<APIGuild>(ctx.env, "GET", `/guilds/${id}`);
          names.set(id, guild.name);
        } catch (err) {
          logError("fetch guild name failed", err);
        }
      }),
    );

    const lines = shown.map((r) => {
      const server = escapeMarkdown(names.get(r.guild_id) ?? "（不明なサーバー）");
      const title = escapeMarkdown(r.title);
      const titleText = r.message_id ? `[${title}](${messageLink(r.guild_id, r.channel_id, r.message_id)})` : title;
      return `**${server}**　<t:${r.start_at}:f>　${titleText}　${STATUS_META[r.status].emoji}`;
    });
    if (rows.length > shown.length) lines.push(`…ほか ${rows.length - shown.length} 件`);

    return {
      embeds: [
        {
          title: "📋 あなたの予定",
          description: lines.join("\n"),
          footer: { text: "✅ 参加・🤔 未定と回答した予定を表示しています" },
        },
      ],
    };
  });
}
