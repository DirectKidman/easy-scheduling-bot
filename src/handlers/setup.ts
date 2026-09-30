import type { APIChatInputApplicationCommandGuildInteraction, APIInteractionResponse } from "discord-api-types/v10";
import { getServer, upsertServer } from "../db/queries";
import { isManager } from "../discord/permissions";
import { retentionDays } from "../env";
import { ephemeral, type Context } from "../interaction";
import { isValidTimeZone } from "../time";
import { getOption } from "./options";

const DEFAULT_TIMEZONE = "Asia/Tokyo";

export function privacyNotice(days: number): string {
  return [
    "**🔒 このbotが保存するデータ**",
    "・サーバー設定（告知チャンネル、運営ロール、タイムゾーン）",
    "・イベントのタイトルと日時、告知メッセージの ID",
    "・ボタンで回答した人のユーザー ID と回答（参加／未定／不参加）",
    "場所・説明は告知メッセージにだけ書かれ、DB には保存しません。メッセージの本文は読みません。",
    `イベントと回答は開始日時から ${days} 日後に自動で削除されます。`,
    "bot の運営者（ホストしている人）は、技術的に DB の内容を読むことができます。",
  ].join("\n");
}

export async function handleSetup(
  ctx: Context,
  interaction: APIChatInputApplicationCommandGuildInteraction,
): Promise<APIInteractionResponse> {
  if (!isManager(interaction.member)) {
    return ephemeral("このコマンドはサーバー管理権限を持つ人だけが実行できます。");
  }
  const options = interaction.data.options;
  const channelId = getOption<string>(options, "channel");
  const roleId = getOption<string>(options, "operator_role") ?? null;
  const tzInput = getOption<string>(options, "timezone")?.trim();
  if (!channelId) return ephemeral("告知チャンネルを指定してください。");

  const existing = await getServer(ctx.env.DB, interaction.guild_id);
  const timezone = tzInput || existing?.timezone || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) {
    return ephemeral(`タイムゾーン「${tzInput}」は使えません。\`Asia/Tokyo\` のような IANA 形式で指定してください。`);
  }
  if (roleId === interaction.guild_id) {
    return ephemeral("@everyone は運営ロールに指定できません。");
  }

  await upsertServer(ctx.env.DB, {
    guild_id: interaction.guild_id,
    announce_channel_id: channelId,
    operator_role_id: roleId,
    timezone,
  });

  return ephemeral(
    [
      "✅ 設定を保存しました。",
      `告知チャンネル: <#${channelId}>`,
      `運営ロール: ${roleId ? `<@&${roleId}>` : "なし（サーバー管理権限を持つ人のみ）"}`,
      `タイムゾーン: \`${timezone}\``,
      "",
      "告知チャンネルで bot が「チャンネルを見る」「メッセージを送信」「埋め込みリンク」「メッセージ履歴を読む」を使えることを確認してください。",
      "",
      privacyNotice(retentionDays(ctx.env)),
    ].join("\n"),
  );
}
