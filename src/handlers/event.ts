import {
  ComponentType,
  InteractionResponseType,
  TextInputStyle,
  type APIChatInputApplicationCommandGuildInteraction,
  type APIInteractionResponse,
  type APIMessage,
  type APIModalSubmitGuildInteraction,
} from "discord-api-types/v10";
import { deleteEvent, getServerOrDefault, insertEvent, setEventMessage, type EventRow } from "../db/queries";
import { isOperator } from "../discord/permissions";
import { DiscordErrorCode, discordRequest, isDiscordError } from "../discord/rest";
import { defer, ephemeral, type Context, type MessageBody } from "../interaction";
import { buildAnnouncement, buildHeader, messageLink } from "../render";
import { parseDuration, parseEventDateTime } from "../time";
import { cannotPostMessage, getModalValue, interactionChannelId } from "./options";

export const EVENT_MODAL_ID = "event:create";

/** 未来すぎる日時の入力ミスを防ぐ上限（2年） */
export const MAX_AHEAD_SECONDS = 2 * 366 * 24 * 60 * 60;

const NOT_OPERATOR = "イベントを作成できるのは運営者（サーバー管理権限または運営ロールを持つ人）だけです。";

export async function handleEventCommand(
  ctx: Context,
  interaction: APIChatInputApplicationCommandGuildInteraction,
): Promise<APIInteractionResponse> {
  const server = await getServerOrDefault(ctx.env.DB, interaction.guild_id);
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
        input("duration", "所要時間（任意・省略時は2時間）", {
          style: TextInputStyle.Short,
          required: false,
          max_length: 20,
          placeholder: "2h / 90m / 1時間30分",
        }),
        input("location", "場所（任意）", { style: TextInputStyle.Short, required: false, max_length: 100 }),
        input("description", "説明（任意）", { style: TextInputStyle.Paragraph, required: false, max_length: 1000 }),
      ],
    },
  } as APIInteractionResponse;
}

export function handleEventModal(
  ctx: Context,
  interaction: APIModalSubmitGuildInteraction,
): APIInteractionResponse {
  // モーダルはすぐ閉じ（「処理中」を返す）、サーバー設定の読み込み・確認・作成は応答の後に行う
  return defer(ctx, interaction.token, "message", () => createEvent(ctx, interaction));
}

async function createEvent(ctx: Context, interaction: APIModalSubmitGuildInteraction): Promise<MessageBody> {
  const server = await getServerOrDefault(ctx.env.DB, interaction.guild_id);
  // モーダルを開いた後に権限が外れた場合に備えて、送信時にも確認する
  if (!isOperator(interaction.member, server)) return { content: NOT_OPERATOR };
  // 告知はコマンドを実行したチャンネルに出す（秘匿チャンネルで実行すれば、そのチャンネルの人にだけ届く）
  const channelId = interactionChannelId(interaction);
  if (!channelId) return { content: "チャンネルの中で実行してください。" };

  const title = getModalValue(interaction, "title")?.trim() ?? "";
  const datetime = getModalValue(interaction, "datetime") ?? "";
  const location = getModalValue(interaction, "location")?.trim() || undefined;
  const description = getModalValue(interaction, "description")?.trim() || undefined;
  if (!title) return { content: "タイトルを入力してください。" };

  const parsed = parseEventDateTime(datetime, server.timezone, ctx.now * 1000);
  if (!parsed.ok) return { content: `⚠️ ${parsed.reason}` };
  if (parsed.unix <= ctx.now) return { content: "⚠️ 過去の日時は指定できません。" };
  if (parsed.unix > ctx.now + MAX_AHEAD_SECONDS) return { content: "⚠️ 2年以上先の日時は指定できません。" };
  const duration = parseDuration(getModalValue(interaction, "duration"));
  if (!duration.ok) return { content: `⚠️ ${duration.reason}` };

  const hostId = interaction.member.user.id;
  const eventId = await insertEvent(ctx.env.DB, {
    guild_id: server.guild_id,
    channel_id: channelId,
    title,
    start_at: parsed.unix,
    duration_minutes: duration.minutes,
  });
  const event: EventRow = {
    id: eventId,
    guild_id: server.guild_id,
    channel_id: channelId,
    message_id: null,
    title,
    start_at: parsed.unix,
    duration_minutes: duration.minutes,
    state: "scheduled",
  };
  const header = buildHeader({
    startAt: parsed.unix,
    durationMinutes: duration.minutes,
    timezone: server.timezone,
    now: ctx.now,
    location,
    hostId,
    description,
  });

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
      return { content: cannotPostMessage(event.channel_id) };
    }
    throw err;
  }
  await setEventMessage(ctx.env.DB, eventId, message.id);
  return { content: `✅ イベントを告知しました: ${messageLink(event.guild_id, event.channel_id, message.id)}` };
}
