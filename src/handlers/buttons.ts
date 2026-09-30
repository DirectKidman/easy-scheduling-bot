import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  type APIInteractionResponse,
  type APIMessageComponentGuildInteraction,
} from "discord-api-types/v10";
import { refreshAnnouncement } from "../announcement";
import {
  getEvent,
  getServer,
  listResponses,
  transitionEventState,
  upsertResponse,
  type EventRow,
  type RsvpStatus,
  type ServerRow,
} from "../db/queries";
import { isOperator } from "../discord/permissions";
import { defer, ephemeral, ephemeralMessage, type Context } from "../interaction";
import { buildAnnouncement, buildRosterDetail, fallbackHeader, STATUSES } from "../render";

const GONE = "このイベントは見つかりませんでした（削除された可能性があります）。";

/**
 * ボタンの custom_id は `<操作>:<イベントID>[:<引数>]`。
 * 常駐プロセスがないので、押されるたびに DB を見て処理する。
 */
export async function handleButton(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
): Promise<APIInteractionResponse> {
  const [action, idText, arg] = interaction.data.custom_id.split(":");
  const eventId = Number(idText);
  if (!Number.isSafeInteger(eventId)) return ephemeral("不明な操作です。");

  const event = await getEvent(ctx.env.DB, eventId);
  // 他サーバーのイベント ID を埋め込んだボタンを受け付けない
  if (!event || event.guild_id !== interaction.guild_id) return ephemeral(GONE);

  switch (action) {
    case "rsvp":
      return handleRsvp(ctx, interaction, event, arg);
    case "detail":
      return handleDetail(ctx, interaction, event);
    case "cancel":
    case "cancelok": {
      const server = await getServer(ctx.env.DB, interaction.guild_id);
      // 権限チェックはボタンが見えるかどうかに頼らず、押されるたびに行う
      if (!server || !isOperator(interaction.member, server)) {
        return ephemeral("イベントを中止できるのは運営者だけです。");
      }
      return action === "cancel" ? confirmCancel(event) : executeCancel(ctx, interaction, event);
    }
    default:
      return ephemeral("不明な操作です。");
  }
}

async function handleRsvp(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
  event: EventRow,
  status: string | undefined,
): Promise<APIInteractionResponse> {
  if (!STATUSES.includes(status as RsvpStatus)) return ephemeral("不明な操作です。");
  if (event.state !== "scheduled") return ephemeral("このイベントは受付を終了しています。");
  if (event.start_at <= ctx.now) return ephemeral("このイベントはすでに開始しています。");

  await upsertResponse(ctx.env.DB, event.id, interaction.member.user.id, status as RsvpStatus, ctx.now);
  const responses = await listResponses(ctx.env.DB, event.id);
  const header = interaction.message.embeds[0]?.description ?? fallbackHeader(event);

  // ボタンが付いたメッセージそのものを応答で書き換える（REST の投稿レート制限を消費しない）。
  // 毎回 DB 全体から再生成するので、連打や同時押しでも最終的に DB と一致する。
  return {
    type: InteractionResponseType.UpdateMessage,
    data: buildAnnouncement(event, header, responses),
  };
}

async function handleDetail(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
  event: EventRow,
): Promise<APIInteractionResponse> {
  const responses = await listResponses(ctx.env.DB, event.id);
  let server: ServerRow | null = null;
  if (event.state === "scheduled") server = await getServer(ctx.env.DB, event.guild_id);
  const canCancel = server !== null && isOperator(interaction.member, server);

  return ephemeralMessage({
    embeds: [{ title: `📅 ${event.title} の回答一覧`, description: buildRosterDetail(event, responses) }],
    components: canCancel
      ? [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                custom_id: `cancel:${event.id}`,
                label: "イベントを中止（運営者）",
              },
            ],
          },
        ]
      : [],
  });
}

function confirmCancel(event: EventRow): APIInteractionResponse {
  if (event.state !== "scheduled") return ephemeral("このイベントはすでに中止または終了しています。");
  return {
    type: InteractionResponseType.UpdateMessage,
    data: {
      content: `「${event.title}」を中止しますか？告知メッセージの回答ボタンが無効になります。`,
      embeds: [],
      allowed_mentions: { parse: [] },
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            { type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: `cancelok:${event.id}`, label: "中止する" },
          ],
        },
      ],
    },
  };
}

function executeCancel(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
  event: EventRow,
): APIInteractionResponse {
  return defer(ctx, interaction.token, "update", async () => {
    const changed = await transitionEventState(ctx.env.DB, event.id, "scheduled", "cancelled");
    if (!changed) return { content: "このイベントはすでに中止または終了しています。", components: [] };
    const result = await refreshAnnouncement(ctx.env, { ...event, state: "cancelled" });
    return {
      content:
        result === "missing"
          ? `「${event.title}」を中止しました（告知メッセージは見つかりませんでした）。`
          : `「${event.title}」を中止しました。`,
      components: [],
    };
  });
}
