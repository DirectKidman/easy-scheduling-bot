import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  TextInputStyle,
  type APIChatInputApplicationCommandGuildInteraction,
  type APIInteractionResponse,
  type APIMessage,
  type APIMessageComponentGuildInteraction,
  type APIModalSubmitGuildInteraction,
} from "discord-api-types/v10";
import { collectBusy, fetchGuildNames, overlapping, type Busy } from "../conflicts";
import {
  confirmPoll,
  deletePoll,
  getPoll,
  insertPoll,
  listCandidates,
  listVotes,
  replaceVotes,
  setPollMessage,
  transitionPollState,
  type PollRow,
  type VoteValue,
} from "../db/polls";
import { getEvent, getServer, listResponses, type ServerRow } from "../db/queries";
import { isOperator } from "../discord/permissions";
import { DiscordErrorCode, discordRequest, isDiscordError } from "../discord/rest";
import { defer, ephemeral, ephemeralMessage, logError, type Context, type MessageBody } from "../interaction";
import { buildAnnouncement, formatTimeRange, messageLink } from "../render";
import {
  buildPollDetail,
  buildPollHeader,
  buildPollMessage,
  buildVotePanel,
  candidateLabel,
  pollHeaderToEventHeader,
  tallyVotes,
} from "../renderPoll";
import { formatLocalShort, parseCandidates, parseDuration } from "../time";
import { MAX_AHEAD_SECONDS } from "./event";
import { getModalValue } from "./options";

export const POLL_MODAL_ID = "poll:create";
export const POLL_PREFIX = "poll:";

const NOT_SET_UP = "このサーバーはまだ設定されていません。サーバー管理者が `/setup` を実行してください。";
const NOT_OPERATOR = "日程調整を作成・確定・中止できるのは運営者（サーバー管理権限または運営ロールを持つ人）だけです。";
const GONE = "この日程調整は見つかりませんでした（確定・削除された可能性があります）。";

// ---- 作成 ----

export async function handlePollCommand(
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
      custom_id: POLL_MODAL_ID,
      title: "日程調整を作成",
      components: [
        input("title", "タイトル", { style: TextInputStyle.Short, required: true, max_length: 100 }),
        input("candidates", `候補日（1行に1つ・${server.timezone}）`, {
          style: TextInputStyle.Paragraph,
          required: true,
          max_length: 1000,
          placeholder: "10/11 19:00\n10/12 14:00\n10/18 19:00",
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

export async function handlePollModal(
  ctx: Context,
  interaction: APIModalSubmitGuildInteraction,
): Promise<APIInteractionResponse> {
  const server = await getServer(ctx.env.DB, interaction.guild_id);
  if (!server) return ephemeral(NOT_SET_UP);
  if (!isOperator(interaction.member, server)) return ephemeral(NOT_OPERATOR);

  const title = getModalValue(interaction, "title")?.trim() ?? "";
  if (!title) return ephemeral("タイトルを入力してください。");
  const candidates = parseCandidates(getModalValue(interaction, "candidates") ?? "", server.timezone, ctx.now * 1000);
  if (!candidates.ok) return ephemeral(`⚠️ ${candidates.reason}`);
  if (candidates.unix.some((u) => u > ctx.now + MAX_AHEAD_SECONDS)) {
    return ephemeral("⚠️ 2年以上先の候補日は指定できません。");
  }
  if (candidates.unix.length < 2) return ephemeral("⚠️ 重複を除くと候補日が 1 つしかありません。");
  const duration = parseDuration(getModalValue(interaction, "duration"));
  if (!duration.ok) return ephemeral(`⚠️ ${duration.reason}`);
  const location = getModalValue(interaction, "location")?.trim() || undefined;
  const description = getModalValue(interaction, "description")?.trim() || undefined;
  const hostId = interaction.member.user.id;

  return defer(ctx, interaction.token, "message", async () => {
    const { poll, candidates: rows } = await insertPoll(
      ctx.env.DB,
      { guild_id: server.guild_id, channel_id: server.announce_channel_id, title, duration_minutes: duration.minutes },
      candidates.unix,
    );
    const header = buildPollHeader({ durationMinutes: duration.minutes, location, hostId, description });
    let message: APIMessage;
    try {
      message = await discordRequest<APIMessage>(ctx.env, "POST", `/channels/${poll.channel_id}/messages`, {
        body: buildPollMessage(poll, header, rows, [], ctx.now),
      });
    } catch (err) {
      await deletePoll(ctx.env.DB, poll.id);
      if (
        isDiscordError(err, DiscordErrorCode.MissingAccess, DiscordErrorCode.MissingPermissions, DiscordErrorCode.UnknownChannel)
      ) {
        return {
          content:
            `⚠️ 告知チャンネル <#${poll.channel_id}> に投稿できませんでした。` +
            "bot の権限（チャンネルを見る・メッセージを送信・埋め込みリンク）を確認するか、`/setup` でチャンネルを設定し直してください。",
        };
      }
      throw err;
    }
    await setPollMessage(ctx.env.DB, poll.id, message.id);
    return { content: `✅ 日程調整を投稿しました: ${messageLink(poll.guild_id, poll.channel_id, message.id)}` };
  });
}

// ---- ボタン・セレクトメニュー ----

/** custom_id は `poll:<操作>:<日程調整ID>[:<候補ID>]` */
export async function handlePollComponent(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
): Promise<APIInteractionResponse> {
  const [, action, idText, arg] = interaction.data.custom_id.split(":");
  const pollId = Number(idText);
  if (!Number.isSafeInteger(pollId)) return ephemeral("不明な操作です。");
  const poll = await getPoll(ctx.env.DB, pollId);
  if (!poll || poll.guild_id !== interaction.guild_id) return ephemeral(GONE);
  const server = await getServer(ctx.env.DB, poll.guild_id);
  if (!server) return ephemeral(GONE);

  switch (action) {
    case "vote":
      if (poll.state !== "open") return ephemeral("この日程調整は受付を終了しています。");
      return defer(ctx, interaction.token, "message", () => votePanel(ctx, poll, server, interaction.member.user.id));
    case "yes":
    case "maybe": {
      if (poll.state !== "open") return ephemeral("この日程調整は受付を終了しています。");
      const values = "values" in interaction.data ? interaction.data.values : [];
      return defer(ctx, interaction.token, "update", () =>
        saveVotes(ctx, poll, server, interaction.member.user.id, action, values),
      );
    }
    case "detail":
      return pollDetail(ctx, poll, server, isOperator(interaction.member, server));
  }

  // ここから先は運営者の操作。ボタンが見えるかどうかに頼らず、毎回権限を確認する
  if (!isOperator(interaction.member, server)) return ephemeral(NOT_OPERATOR);
  if (poll.state !== "open") return ephemeral("この日程調整はすでに終了しています。");
  switch (action) {
    case "pick": {
      const values = "values" in interaction.data ? interaction.data.values : [];
      return confirmPick(ctx, poll, server, Number(values[0]));
    }
    case "confirm":
      return defer(ctx, interaction.token, "update", () => executeConfirm(ctx, poll, Number(arg)));
    case "cancel":
      return update({
        content: `「${poll.title}」の日程調整を中止しますか？投票メッセージの回答ボタンが無効になります。`,
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: `poll:cancelok:${poll.id}`, label: "中止する" },
            ],
          },
        ],
      });
    case "cancelok":
      return defer(ctx, interaction.token, "update", async () => {
        if (!(await transitionPollState(ctx.env.DB, poll.id, "open", "cancelled"))) {
          return { content: "この日程調整はすでに終了しています。", components: [] };
        }
        await refreshPollMessage(ctx, { ...poll, state: "cancelled" });
        return { content: `「${poll.title}」の日程調整を中止しました。`, embeds: [], components: [] };
      });
  }
  return ephemeral("不明な操作です。");
}

function update(body: MessageBody): APIInteractionResponse {
  return {
    type: InteractionResponseType.UpdateMessage,
    data: { embeds: [], components: [], allowed_mentions: { parse: [] }, ...body } as never,
  };
}

/** 回答パネル: 本人の今の回答と、候補ごとの予定の重なりを出す */
async function votePanel(ctx: Context, poll: PollRow, server: ServerRow, userId: string): Promise<MessageBody> {
  const [candidates, votes] = await Promise.all([listCandidates(ctx.env.DB, poll.id), listVotes(ctx.env.DB, poll.id)]);
  const myVotes = new Map<number, VoteValue>(
    votes.filter((v) => v.user_id === userId).map((v) => [v.candidate_id, v.value]),
  );

  const conflicts = new Map<number, Busy[]>();
  const ranges = candidates.map((c) => ({ id: c.id, start: c.start_at, end: c.start_at + poll.duration_minutes * 60 }));
  if (ranges.length > 0) {
    const busy = await collectBusy(
      ctx.env,
      userId,
      Math.min(...ranges.map((r) => r.start)),
      Math.max(...ranges.map((r) => r.end)),
      { pollId: poll.id },
    );
    for (const r of ranges) conflicts.set(r.id, overlapping(busy, r));
  }
  const guildNames = await fetchGuildNames(
    ctx.env,
    [...conflicts.values()].flat().map((b) => b.guild_id),
  );

  return buildVotePanel({ poll, candidates, myVotes, conflicts, guildNames, timezone: server.timezone, now: ctx.now });
}

async function saveVotes(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  userId: string,
  value: VoteValue,
  values: string[],
): Promise<MessageBody> {
  const candidates = await listCandidates(ctx.env.DB, poll.id);
  // 開始済みの候補は締め切り。選択肢にも出していないが、古いパネルからの送信に備えてここでも弾く
  const editable = candidates.filter((c) => c.start_at > ctx.now).map((c) => c.id);
  const editableSet = new Set(editable);
  const selected = values.map(Number).filter((id) => editableSet.has(id));
  await replaceVotes(ctx.env.DB, userId, value, selected, editable, ctx.now);

  // 公開の投票メッセージの書き換えは、本人の回答パネルの更新を待たせないよう並行して進める
  ctx.exec.waitUntil(
    refreshPollMessage(ctx, poll).catch((err) => logError("refresh poll message failed", err)),
  );
  return votePanel(ctx, poll, server, userId);
}

async function pollDetail(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  operator: boolean,
): Promise<APIInteractionResponse> {
  const [candidates, votes] = await Promise.all([listCandidates(ctx.env.DB, poll.id), listVotes(ctx.env.DB, poll.id)]);
  return ephemeralMessage(
    buildPollDetail({ poll, candidates, votes, timezone: server.timezone, isOperator: operator, now: ctx.now }),
  );
}

async function confirmPick(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  candidateId: number,
): Promise<APIInteractionResponse> {
  const [candidates, votes] = await Promise.all([listCandidates(ctx.env.DB, poll.id), listVotes(ctx.env.DB, poll.id)]);
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate || candidate.start_at <= ctx.now) return update({ content: "その候補日は選べません。" });
  const t = tallyVotes(candidates, votes).get(candidate.id)!;
  return update({
    content: [
      `「${poll.title}」を **${candidateLabel(candidate)} ${formatLocalShort(candidate.start_at, server.timezone)}** で確定しますか？`,
      `この日に ⭕ の ${t.yes.length} 人は「参加」、🔺 の ${t.maybe.length} 人は「未定」として引き継ぎます。`,
      "投票メッセージは確定イベントの告知に切り替わり、リマインドの対象になります。候補日ごとの投票データは削除されます。",
    ].join("\n"),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Success,
            custom_id: `poll:confirm:${poll.id}:${candidate.id}`,
            label: "確定する",
          },
        ],
      },
    ],
  });
}

async function executeConfirm(ctx: Context, poll: PollRow, candidateId: number): Promise<MessageBody> {
  const candidates = await listCandidates(ctx.env.DB, poll.id);
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate || candidate.start_at <= ctx.now) return { content: "その候補日は選べません。", components: [] };

  // 先に投票メッセージの本文を読んでおく（確定後は日程調整の行が消えるため）
  let pollHeader: string | undefined;
  if (poll.message_id) {
    try {
      const message = await discordRequest<APIMessage>(
        ctx.env,
        "GET",
        `/channels/${poll.channel_id}/messages/${poll.message_id}`,
      );
      pollHeader = message.embeds[0]?.description;
    } catch (err) {
      if (!isDiscordError(err, DiscordErrorCode.UnknownMessage, DiscordErrorCode.UnknownChannel)) throw err;
    }
  }

  const eventId = await confirmPoll(ctx.env.DB, poll, candidate, ctx.now);
  if (eventId === null) return { content: "この日程調整はすでに確定または中止されています。", components: [] };
  const event = (await getEvent(ctx.env.DB, eventId))!;
  const dateLine = `日時　${formatTimeRange(event.start_at, event.duration_minutes)}`;
  const header = pollHeader ? pollHeaderToEventHeader(pollHeader, dateLine) : dateLine;

  let note = "";
  if (event.message_id && pollHeader !== undefined) {
    const responses = await listResponses(ctx.env.DB, event.id);
    await discordRequest(ctx.env, "PATCH", `/channels/${event.channel_id}/messages/${event.message_id}`, {
      body: buildAnnouncement(event, header, responses),
    });
  } else {
    note = "\n（投票メッセージが見つからなかったため、告知メッセージは更新していません。）";
  }
  return {
    content: `✅ 「${poll.title}」を ${formatTimeRange(event.start_at, event.duration_minutes)} で確定しました。${note}`,
    embeds: [],
    components: [],
  };
}

/** 投票メッセージを DB の状態から描き直す。消されていれば message_deleted にする */
export async function refreshPollMessage(ctx: Context, poll: PollRow): Promise<void> {
  if (!poll.message_id) return;
  const path = `/channels/${poll.channel_id}/messages/${poll.message_id}`;
  try {
    const message = await discordRequest<APIMessage>(ctx.env, "GET", path);
    const header = message.embeds[0]?.description ?? "";
    const [candidates, votes] = await Promise.all([listCandidates(ctx.env.DB, poll.id), listVotes(ctx.env.DB, poll.id)]);
    await discordRequest(ctx.env, "PATCH", path, { body: buildPollMessage(poll, header, candidates, votes, ctx.now) });
  } catch (err) {
    if (isDiscordError(err, DiscordErrorCode.UnknownMessage, DiscordErrorCode.UnknownChannel)) {
      await transitionPollState(ctx.env.DB, poll.id, "open", "message_deleted");
      return;
    }
    throw err;
  }
}
