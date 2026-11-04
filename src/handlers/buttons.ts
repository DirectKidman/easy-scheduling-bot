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
  getServerOrDefault,
  listResponses,
  respondAndList,
  transitionEventState,
  type EventRow,
  type ResponseRow,
  type RsvpStatus,
  type ServerRow,
} from "../db/queries";
import { isOperator } from "../discord/permissions";
import { collectBusy, fetchGuildNames, formatBusyLine } from "../conflicts";
import { defer, ephemeral, ephemeralMessage, followupEphemeral, logError, type Context } from "../interaction";
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

  // 回答は、イベントの確認・保存・名簿の読み込みを 1 回の往復で済ませる
  if (action === "rsvp") return handleRsvp(ctx, interaction, eventId, arg);

  // イベントと、必要ならサーバー設定・名簿を並行して読む（往復 1 回）
  const [event, server, responses] = await Promise.all([
    getEvent(ctx.env.DB, eventId),
    action === "cancel" || action === "cancelok" || action === "detail"
      ? getServer(ctx.env.DB, interaction.guild_id)
      : null,
    action === "detail" ? listResponses(ctx.env.DB, eventId) : [],
  ]);
  // 他サーバーのイベント ID を埋め込んだボタンを受け付けない
  if (!event || event.guild_id !== interaction.guild_id) return ephemeral(GONE);

  switch (action) {
    case "detail":
      return handleDetail(interaction, event, server, responses);
    case "cancel":
    case "cancelok": {
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
  eventId: number,
  status: string | undefined,
): Promise<APIInteractionResponse> {
  if (!STATUSES.includes(status as RsvpStatus)) return ephemeral("不明な操作です。");

  const { event, responses } = await respondAndList(ctx.env.DB, {
    eventId,
    guildId: interaction.guild_id,
    userId: interaction.member.user.id,
    status: status as RsvpStatus,
    now: ctx.now,
  });
  // 他サーバーのイベント ID を埋め込んだボタンを受け付けない（この場合は保存もしていない）
  if (!event || event.guild_id !== interaction.guild_id) return ephemeral(GONE);
  if (event.state !== "scheduled") return ephemeral("このイベントは受付を終了しています。");
  if (event.start_at <= ctx.now) return ephemeral("このイベントはすでに開始しています。");

  const header =
    interaction.message.embeds[0]?.description ??
    fallbackHeader(event, (await getServerOrDefault(ctx.env.DB, event.guild_id)).timezone);

  if (status === "going" || status === "maybe") {
    ctx.exec.waitUntil(warnConflicts(ctx, interaction, event));
  }

  // ボタンが付いたメッセージそのものを応答で書き換える（REST の投稿レート制限を消費しない）。
  // 毎回 DB 全体から再生成するので、連打や同時押しでも最終的に DB と一致する。
  return {
    type: InteractionResponseType.UpdateMessage,
    data: buildAnnouncement(event, header, responses),
  };
}

function handleDetail(
  interaction: APIMessageComponentGuildInteraction,
  event: EventRow,
  server: ServerRow | null,
  responses: ResponseRow[],
): APIInteractionResponse {
  const canCancel = event.state === "scheduled" && server !== null && isOperator(interaction.member, server);

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

/**
 * 参加・未定にしたとき、同じ時間帯に他の予定（全サーバー横断）があれば本人にだけ知らせる。
 * 回答自体は受け付ける（止めない）。
 */
async function warnConflicts(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
  event: EventRow,
): Promise<void> {
  try {
    const end = event.start_at + event.duration_minutes * 60;
    const busy = await collectBusy(ctx.env, interaction.member.user.id, event.start_at, end, { eventId: event.id });
    if (busy.length === 0) return;
    const names = await fetchGuildNames(ctx.env, busy.map((b) => b.guild_id));
    const body = {
      content: [
        `⚠️ 「${event.title}」の時間帯に、他の予定があります（あなたにだけ表示）`,
        ...busy.map((b) => `・${formatBusyLine(b, names)}`),
      ].join("\n"),
    };
    try {
      await followupEphemeral(ctx.env, interaction.token, body);
    } catch {
      // ボタンへの応答が Discord に届く前に追加メッセージを送ってしまった場合に備え、少し待って 1 回だけ再送する
      await new Promise((r) => setTimeout(r, 1000));
      await followupEphemeral(ctx.env, interaction.token, body);
    }
  } catch (err) {
    logError("conflict warning failed", err);
  }
}
