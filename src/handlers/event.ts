import {
  ComponentType,
  InteractionResponseType,
  TextInputStyle,
  type APIChatInputApplicationCommandGuildInteraction,
  type APIInteractionResponse,
  type APIMessage,
  type APIModalSubmitGuildInteraction,
} from "discord-api-types/v10";
import { deleteEvent, getServer, insertEvent, setEventMessage, type EventRow } from "../db/queries";
import { isOperator } from "../discord/permissions";
import { DiscordErrorCode, discordRequest, isDiscordError } from "../discord/rest";
import { defer, ephemeral, type Context } from "../interaction";
import { buildAnnouncement, buildHeader, messageLink } from "../render";
import { parseEventDateTime } from "../time";
import { getModalValue } from "./options";

export const EVENT_MODAL_ID = "event:create";

/** 未来すぎる日時の入力ミスを防ぐ上限（2年） */
const MAX_AHEAD_SECONDS = 2 * 366 * 24 * 60 * 60;

const NOT_SET_UP = "このサーバーはまだ設定されていません。サーバー管理者が `/setup` を実行してください。";
const NOT_OPERATOR = "イベントを作成できるのは運営者（サーバー管理権限または運営ロールを持つ人）だけです。";

export async function handleEventCommand(
  ctx: Context,
  interaction: APIChatInputApplicationCommandGuildInteraction,
): Promise<APIInteractionResponse> {
  const server = await getServer(ctx.env.DB, interaction.guild_id);
  if (!server) return ephemeral(NOT_SET_UP);
  if (!isOperator(interaction.member, server)) return ephemeral(NOT_OPERATOR);

  const input = (customId: string, label: string, opts: Record<string, unknown>) => ({
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.TextInput, custom_id: customId, label, ...opts }],
  });

  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: EVENT_MODAL_ID,
      title: "イベントを作成",
      components: [
        input("title", "タイトル", { style: TextInputStyle.Short, required: true, max_length: 100 }),
        input("datetime", `日時（${server.timezone}）`, {
          style: TextInputStyle.Short,
          required: true,
          max_length: 40,
          placeholder: "2026-10-11 19:00",
        }),
        input("location", "場所（任意）", { style: TextInputStyle.Short, required: false, max_length: 100 }),
        input("description", "説明（任意）", { style: TextInputStyle.Paragraph, required: false, max_length: 1000 }),
      ],
    },
  } as APIInteractionResponse;
}

export async function handleEventModal(
  ctx: Context,
  interaction: APIModalSubmitGuildInteraction,
): Promise<APIInteractionResponse> {
  const server = await getServer(ctx.env.DB, interaction.guild_id);
  if (!server) return ephemeral(NOT_SET_UP);
  // モーダルを開いた後に権限が外れた場合に備えて、送信時にも確認する
  if (!isOperator(interaction.member, server)) return ephemeral(NOT_OPERATOR);

  const title = getModalValue(interaction, "title")?.trim() ?? "";
  const datetime = getModalValue(interaction, "datetime") ?? "";
  const location = getModalValue(interaction, "location")?.trim() || undefined;
  const description = getModalValue(interaction, "description")?.trim() || undefined;
  if (!title) return ephemeral("タイトルを入力してください。");

  const parsed = parseEventDateTime(datetime, server.timezone, ctx.now * 1000);
  if (!parsed.ok) return ephemeral(`⚠️ ${parsed.reason}`);
  if (parsed.unix <= ctx.now) return ephemeral("⚠️ 過去の日時は指定できません。");
  if (parsed.unix > ctx.now + MAX_AHEAD_SECONDS) return ephemeral("⚠️ 2年以上先の日時は指定できません。");

  const hostId = interaction.member.user.id;
  return defer(ctx, interaction.token, "message", async () => {
    const eventId = await insertEvent(ctx.env.DB, {
      guild_id: server.guild_id,
      channel_id: server.announce_channel_id,
      title,
      start_at: parsed.unix,
    });
    const event: EventRow = {
      id: eventId,
      guild_id: server.guild_id,
      channel_id: server.announce_channel_id,
      message_id: null,
      title,
      start_at: parsed.unix,
      state: "scheduled",
    };
    const header = buildHeader({ startAt: parsed.unix, location, hostId, description });

    let message: APIMessage;
    try {
      message = await discordRequest<APIMessage>(ctx.env, "POST", `/channels/${event.channel_id}/messages`, {
        body: buildAnnouncement(event, header, []),
      });
    } catch (err) {
      await deleteEvent(ctx.env.DB, eventId);
      if (
        isDiscordError(
          err,
          DiscordErrorCode.MissingAccess,
          DiscordErrorCode.MissingPermissions,
          DiscordErrorCode.UnknownChannel,
        )
      ) {
        return {
          content:
            `⚠️ 告知チャンネル <#${event.channel_id}> に投稿できませんでした。` +
            "bot の権限（チャンネルを見る・メッセージを送信・埋め込みリンク）を確認するか、`/setup` でチャンネルを設定し直してください。",
        };
      }
      throw err;
    }
    await setEventMessage(ctx.env.DB, eventId, message.id);
    return { content: `✅ イベントを告知しました: ${messageLink(event.guild_id, event.channel_id, message.id)}` };
  });
}
