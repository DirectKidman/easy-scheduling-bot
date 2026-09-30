import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  type APIButtonComponentWithCustomId,
  type APIChatInputApplicationCommandGuildInteraction,
  type APIInteractionResponse,
  type APIMessageComponentGuildInteraction,
} from "discord-api-types/v10";
import { refreshAnnouncement } from "../announcement";
import {
  countResponsesForUser,
  deleteAllResponses,
  deletePastResponses,
  getEvent,
  listFutureEventsForUser,
} from "../db/queries";
import { VOTE_MARK } from "../conflicts";
import {
  countPollVotesForUser,
  deleteAllPollVotes,
  deletePastPollVotes,
  getPoll,
  listOpenPollVotesForUser,
} from "../db/polls";
import { defer, ephemeralMessage, logError, type Context, type MessageBody } from "../interaction";
import { refreshPollMessage } from "./poll";
import { escapeMarkdown, messageLink, STATUS_META } from "../render";

export const FORGET_PREFIX = "forget:";

/** 確認画面に並べる今後の予定の最大件数 */
const MAX_LISTED = 15;
/** 削除後に再描画する告知メッセージの最大件数（REST の呼び出し回数を抑える） */
const MAX_REFRESH = 20;

function btn(customId: string, label: string, style: APIButtonComponentWithCustomId["style"]) {
  return { type: ComponentType.Button, custom_id: `${FORGET_PREFIX}${customId}`, label, style } as const;
}

function update(body: MessageBody): APIInteractionResponse {
  return {
    type: InteractionResponseType.UpdateMessage,
    data: { embeds: [], components: [], allowed_mentions: { parse: [] }, ...body } as never,
  };
}

/** /forget: 自分にだけ見える確認画面で範囲を選ぶ */
export async function handleForgetCommand(
  ctx: Context,
  interaction: APIChatInputApplicationCommandGuildInteraction,
): Promise<APIInteractionResponse> {
  const userId = interaction.member.user.id;
  const [responses, votes] = await Promise.all([
    countResponsesForUser(ctx.env.DB, userId, ctx.now),
    countPollVotesForUser(ctx.env.DB, userId, ctx.now),
  ]);
  const counts = { past: responses.past + votes.past, future: responses.future + votes.future };
  if (counts.past + counts.future === 0) {
    return ephemeralMessage({ content: "🗑️ 削除できる回答はありません。" });
  }
  return ephemeralMessage({
    content: [
      "🗑️ **自分の回答を削除します。範囲を選んでください。**",
      `・過去分だけ: 終了済みのイベント・候補日への回答 ${counts.past} 件（今後の予定には影響しません）`,
      `・すべて: 全サーバー分の回答 ${counts.past + counts.future} 件（今後の予定・日程調整への回答 ${counts.future} 件も消えます）`,
      "",
      "削除すると「未回答」に戻ります（「不参加」とは別です）。元に戻すことはできません。",
    ].join("\n"),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          btn("past", "過去分だけ削除", ButtonStyle.Primary),
          btn("all", "すべて削除…", ButtonStyle.Danger),
          btn("cancel", "キャンセル", ButtonStyle.Secondary),
        ],
      },
    ],
  });
}

export async function handleForgetButton(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
): Promise<APIInteractionResponse> {
  const userId = interaction.member.user.id;
  const action = interaction.data.custom_id.slice(FORGET_PREFIX.length);

  switch (action) {
    case "past": {
      const n =
        (await deletePastResponses(ctx.env.DB, userId, ctx.now)) +
        (await deletePastPollVotes(ctx.env.DB, userId, ctx.now));
      return update({ content: `🗑️ 終了済みのイベント・候補日への回答を ${n} 件削除しました。` });
    }
    case "all":
      return confirmAll(ctx, userId);
    case "allok":
      return defer(ctx, interaction.token, "update", () => executeAll(ctx, userId));
    case "cancel":
      return update({ content: "キャンセルしました。回答は削除していません。" });
    default:
      return update({ content: "不明な操作です。" });
  }
}

/** 「すべて」の確認画面: 影響を受ける今後の予定と日程調整を具体的に出す */
async function confirmAll(ctx: Context, userId: string): Promise<APIInteractionResponse> {
  const [future, votes] = await Promise.all([
    listFutureEventsForUser(ctx.env.DB, userId, ctx.now),
    listOpenPollVotesForUser(ctx.env.DB, userId, ctx.now),
  ]);
  const link = (title: string, guildId: string, channelId: string, messageId: string | null) => {
    const t = escapeMarkdown(title);
    return messageId ? `[${t}](${messageLink(guildId, channelId, messageId)})` : t;
  };
  const lines = future.map(
    (e) => `・<t:${e.start_at}:f>　${link(e.title, e.guild_id, e.channel_id, e.message_id)}　${STATUS_META[e.status].emoji}`,
  );
  for (const v of votes) {
    lines.push(`・<t:${v.start_at}:f>　${link(v.title, v.guild_id, v.channel_id, v.message_id)}（日程調整）　${VOTE_MARK[v.value]}`);
  }
  const total = lines.length;
  const listed = lines.slice(0, MAX_LISTED);
  if (total > MAX_LISTED) listed.push(`…ほか ${total - MAX_LISTED} 件`);

  return update({
    content: [
      "⚠️ **全サーバー分の回答をすべて削除します。よろしいですか？**",
      total > 0
        ? `次の今後の予定・候補日 ${total} 件への回答も消え、集計から外れます:`
        : "今後の予定への回答はありません（過去分だけが消えます）。",
      ...listed,
    ].join("\n"),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [btn("cancel", "キャンセル", ButtonStyle.Secondary), btn("allok", "削除する", ButtonStyle.Danger)],
      },
    ],
  });
}

async function executeAll(ctx: Context, userId: string): Promise<MessageBody> {
  // 再描画の対象は、削除前に回答していた今後の予定
  const affected = await listFutureEventsForUser(ctx.env.DB, userId, ctx.now);
  const affectedPolls = [...new Set((await listOpenPollVotesForUser(ctx.env.DB, userId, ctx.now)).map((v) => v.poll_id))];
  const n = (await deleteAllResponses(ctx.env.DB, userId)) + (await deleteAllPollVotes(ctx.env.DB, userId));

  // 影響を受けた告知メッセージの名簿を更新する（失敗しても削除自体は完了している）
  for (const row of affected.slice(0, MAX_REFRESH)) {
    try {
      const event = await getEvent(ctx.env.DB, row.event_id);
      if (event) await refreshAnnouncement(ctx.env, event);
    } catch (err) {
      logError("refresh after forget failed", err);
    }
  }
  for (const pollId of affectedPolls.slice(0, MAX_REFRESH)) {
    try {
      const poll = await getPoll(ctx.env.DB, pollId);
      if (poll) await refreshPollMessage(ctx, poll);
    } catch (err) {
      logError("refresh poll after forget failed", err);
    }
  }
  return {
    content:
      `🗑️ 全サーバー分の回答を ${n} 件削除しました。` +
      (affected.length > MAX_REFRESH || affectedPolls.length > MAX_REFRESH ? "\n一部の告知メッセージの名簿は、次に誰かが回答したときに更新されます。" : ""),
    components: [],
  };
}
