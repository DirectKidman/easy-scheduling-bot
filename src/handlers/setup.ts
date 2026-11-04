import type { APIChatInputApplicationCommandGuildInteraction, APIInteractionResponse } from "discord-api-types/v10";
import { DEFAULT_TIMEZONE, getServer, upsertServer, type ReminderMode } from "../db/queries";
import { isManager } from "../discord/permissions";
import { retentionDays } from "../env";
import { ephemeral, type Context } from "../interaction";
import { isValidTimeZone } from "../time";
import { getOption, interactionChannelId } from "./options";

export function privacyNotice(days: number): string {
  return [
    "**🔒 このbotが保存するデータ**",
    "・サーバー設定（運営ロール、タイムゾーン、リマインドの送り方）",
    "・イベント・日程調整のタイトルと日時、告知したチャンネルとメッセージの ID",
    "・ボタンで回答した人のユーザー ID と回答（参加／未定／不参加、〇／△／×）",
    "場所・説明は告知メッセージにだけ書かれ、DB には保存しません。メッセージの本文は読みません。",
    `イベントと回答は開始日時から ${days} 日後に自動で削除されます。`,
    "自分の回答は `/forget` でいつでも削除できます。",
    "bot をサーバーから外すと、猶予期間の後にそのサーバーの設定・イベント・回答をすべて削除します。",
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
  const roleInput = getOption<string>(options, "operator_role");
  const clearRole = getOption<boolean>(options, "clear_operator_role") === true;
  const tzInput = getOption<string>(options, "timezone")?.trim();
  const reminderOption = getOption<string>(options, "reminder");
  const reminderInput = reminderOption === "channel" || reminderOption === "dm" ? reminderOption : undefined;

  // 省略した項目は今の設定を引き継ぐ（初回は既定値）
  const existing = await getServer(ctx.env.DB, interaction.guild_id);
  const roleId = clearRole ? null : (roleInput ?? existing?.operator_role_id ?? null);
  const timezone = tzInput || existing?.timezone || DEFAULT_TIMEZONE;
  const reminderMode: ReminderMode = reminderInput ?? existing?.reminder_mode ?? "channel";
  if (!isValidTimeZone(timezone)) {
    return ephemeral(`タイムゾーン「${tzInput}」は使えません。\`Asia/Tokyo\` のような IANA 形式で指定してください。`);
  }
  if (roleId === interaction.guild_id) {
    return ephemeral("@everyone は運営ロールに指定できません。");
  }

  await upsertServer(
    ctx.env.DB,
    { guild_id: interaction.guild_id, operator_role_id: roleId, timezone, reminder_mode: reminderMode },
    interactionChannelId(interaction) ?? "",
  );

  return ephemeral(
    [
      "✅ 設定を保存しました。",
      `運営ロール: ${roleId ? `<@&${roleId}>` : "なし（サーバー管理権限を持つ人のみ）"}`,
      `タイムゾーン: \`${timezone}\``,
      `リマインド: ${reminderMode === "dm" ? "DM（届かない人は告知したチャンネルでメンション）" : "告知したチャンネルでメンション"}（開始の約24時間前と約1〜2時間前）`,
      "",
      "`/event`・`/poll` は、実行したチャンネルに告知を投稿します（リマインドもそのチャンネルに届きます）。",
      "秘匿チャンネルで使うときは、そのチャンネルに bot を追加し、「チャンネルを見る」「メッセージを送信」「埋め込みリンク」「メッセージ履歴を読む」を許可してください。",
      "",
      privacyNotice(retentionDays(ctx.env)),
    ].join("\n"),
  );
}
