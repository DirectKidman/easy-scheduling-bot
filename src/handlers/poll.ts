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
  setPollMessage,
  setVote,
  transitionPollState,
  type CandidateRow,
  type PollRow,
  type VoteRow,
  type VoteValue,
} from "../db/polls";
import {
  getEvent,
  getServerOrDefault,
  listResponses,
  type EventRow,
  type ServerRow,
} from "../db/queries";
import { isOperator } from "../discord/permissions";
import { DiscordErrorCode, discordRequest, isDiscordError } from "../discord/rest";
import {
  defer,
  editOriginal,
  ephemeral,
  ephemeralMessage,
  interactionTime,
  logError,
  type Context,
  type MessageBody,
} from "../interaction";
import { buildAnnouncement, messageLink } from "../render";
import {
  applyVoteToPanel,
  buildConfirmedPollMessage,
  buildPollDetail,
  buildPollHeader,
  buildPollMessage,
  buildVotePanel,
  pollHeaderToEventHeader,
  tallyText,
  tallyVotes,
  VOTE_VALUES,
} from "../renderPoll";
import { formatDateTime, formatRange, parseCandidates, parseDuration } from "../time";
import { MAX_AHEAD_SECONDS } from "./event";
import { cannotPostMessage, getModalValue, interactionChannelId } from "./options";

export const POLL_MODAL_ID = "poll:create";
export const POLL_PREFIX = "poll:";

const NOT_OPERATOR = "日程調整を作成・確定・中止できるのは運営者（サーバー管理権限または運営ロールを持つ人）だけです。";
const GONE = "この日程調整は見つかりませんでした（確定・削除された可能性があります）。";

// ---- 作成 ----

export async function handlePollCommand(
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

export function handlePollModal(
  ctx: Context,
  interaction: APIModalSubmitGuildInteraction,
): APIInteractionResponse {
  // モーダルはすぐ閉じ（「処理中」を返す）、サーバー設定の読み込み・確認・作成は応答の後に行う
  return defer(ctx, interaction.token, "message", () => createPoll(ctx, interaction));
}

async function createPoll(ctx: Context, interaction: APIModalSubmitGuildInteraction): Promise<MessageBody> {
  const server = await getServerOrDefault(ctx.env.DB, interaction.guild_id);
  if (!isOperator(interaction.member, server)) return { content: NOT_OPERATOR };
  // 告知はコマンドを実行したチャンネルに出す（秘匿チャンネルで実行すれば、そのチャンネルの人にだけ届く）
  const channelId = interactionChannelId(interaction);
  if (!channelId) return { content: "チャンネルの中で実行してください。" };

  const title = getModalValue(interaction, "title")?.trim() ?? "";
  if (!title) return { content: "タイトルを入力してください。" };
  const candidates = parseCandidates(getModalValue(interaction, "candidates") ?? "", server.timezone, ctx.now * 1000);
  if (!candidates.ok) return { content: `⚠️ ${candidates.reason}` };
  if (candidates.unix.some((u) => u > ctx.now + MAX_AHEAD_SECONDS)) {
    return { content: "⚠️ 2年以上先の候補日は指定できません。" };
  }
  if (candidates.unix.length < 2) return { content: "⚠️ 重複を除くと候補日が 1 つしかありません。" };
  const duration = parseDuration(getModalValue(interaction, "duration"));
  if (!duration.ok) return { content: `⚠️ ${duration.reason}` };
  const location = getModalValue(interaction, "location")?.trim() || undefined;
  const description = getModalValue(interaction, "description")?.trim() || undefined;
  const hostId = interaction.member.user.id;

  const { poll, candidates: rows } = await insertPoll(
    ctx.env.DB,
    { guild_id: server.guild_id, channel_id: channelId, title, duration_minutes: duration.minutes },
    candidates.unix,
  );
  const header = buildPollHeader({ durationMinutes: duration.minutes, location, hostId, description });
  let message: APIMessage;
  try {
    message = await discordRequest<APIMessage>(ctx.env, "POST", `/channels/${poll.channel_id}/messages`, {
      body: buildPollMessage(poll, header, rows, [], server.timezone, ctx.now),
    });
  } catch (err) {
    await deletePoll(ctx.env.DB, poll.id);
    if (
      isDiscordError(err, DiscordErrorCode.MissingAccess, DiscordErrorCode.MissingPermissions, DiscordErrorCode.UnknownChannel)
    ) {
      return { content: cannotPostMessage(poll.channel_id) };
    }
    throw err;
  }
  await setPollMessage(ctx.env.DB, poll.id, message.id);
  return { content: `✅ 日程調整を投稿しました: ${messageLink(poll.guild_id, poll.channel_id, message.id)}` };
}

// ---- ボタン・セレクトメニュー ----

/**
 * custom_id は `poll:<操作>:<日程調整ID>[:<引数>…]`。
 * - `poll:vote:<ID>` 回答パネルを開く / `poll:v:<ID>:<候補ID>:<yes|maybe|no>:<ページ>` 回答 / `poll:page:<ID>:<ページ>`
 * - `poll:detail:<ID>` 詳細 / `poll:pick:<ID>`・`poll:fix:<ID>:<候補の位置>.<候補の位置>…` 確定 / `poll:cancel:<ID>`・`poll:cancelok:<ID>` 中止
 *   （確定ボタンは候補 ID ではなく位置を並べる。custom_id の 100 文字に、候補 20 個ぶんを収めるため）
 */
export async function handlePollComponent(
  ctx: Context,
  interaction: APIMessageComponentGuildInteraction,
): Promise<APIInteractionResponse> {
  const [, action, idText, ...args] = interaction.data.custom_id.split(":");
  const pollId = Number(idText);
  if (!Number.isSafeInteger(pollId)) return ephemeral("不明な操作です。");
  const userId = interaction.member.user.id;

  // ⭕🔺❌: 押されたパネルをその場で書き換えて、DB を一度も待たずに返す。
  // 日程調整の確認・保存・投票メッセージの描き直しは応答の後に行う（persistVote）
  if (action === "v") {
    const [candText, value, pageText] = args;
    if (!VOTE_VALUES.includes(value as VoteValue)) return ephemeral("不明な操作です。");
    const instant = applyVoteToPanel(interaction.message, interaction.data.custom_id);
    if (instant) {
      const vote = { candidateId: Number(candText), value: instant.value, page: Number(pageText) || 0 };
      ctx.exec.waitUntil(
        persistVote(ctx, pollId, interaction, vote).catch((err) => logError("persist vote failed", err)),
      );
      return { type: InteractionResponseType.UpdateMessage, data: { ...instant.body, allowed_mentions: { parse: [] } } };
    }
  }

  // 回答パネルを開く・ページを送る: DB を待たずに「処理中」を返し、確認と読み込みは 1 回の往復でまとめて行う
  if (action === "vote" || action === "page") {
    const page = action === "page" ? Number(args[0]) || 0 : 0;
    return defer(ctx, interaction.token, action === "vote" ? "message" : "update", () =>
      openVotePanel(ctx, pollId, interaction.guild_id, userId, page),
    );
  }

  // 日程調整・サーバー設定と、必要なら候補日・回答を並行して読む（往復 1 回）
  const withVotes = action === "detail" || action === "pick";
  const [poll, server, candidates, votes] = await Promise.all([
    getPoll(ctx.env.DB, pollId),
    getServerOrDefault(ctx.env.DB, interaction.guild_id),
    withVotes ? listCandidates(ctx.env.DB, pollId) : [],
    withVotes ? listVotes(ctx.env.DB, pollId) : [],
  ]);
  if (!poll || poll.guild_id !== interaction.guild_id) return ephemeral(GONE);

  switch (action) {
    case "v": {
      // パネルが想定した形でなかったとき: 従来どおり DB から作り直す
      if (poll.state !== "open") return ephemeral("この日程調整は受付を終了しています。");
      const [candText, value, pageText] = args;
      return defer(ctx, interaction.token, "update", () =>
        saveVote(ctx, poll, server, userId, Number(candText), value as VoteValue, Number(pageText) || 0, interaction.id),
      );
    }
    case "detail":
      return ephemeralMessage(
        buildPollDetail({
          poll,
          candidates,
          votes,
          timezone: server.timezone,
          isOperator: isOperator(interaction.member, server),
          now: ctx.now,
        }),
      );
    case "yes":
    case "maybe":
      // 以前のセレクトメニュー式の回答パネル（開いたままのもの）からの操作
      return ephemeral("回答パネルが新しくなりました。投票メッセージの [🗳️ 回答する] から開き直してください。");
  }

  // ここから先は運営者の操作。ボタンが見えるかどうかに頼らず、毎回権限を確認する
  if (!isOperator(interaction.member, server)) return ephemeral(NOT_OPERATOR);
  if (poll.state !== "open") return ephemeral("この日程調整はすでに終了しています。");
  switch (action) {
    case "pick": {
      const values = "values" in interaction.data ? interaction.data.values : [];
      return confirmPick(ctx, poll, server, candidates, votes, values.map(Number));
    }
    case "fix":
      return defer(ctx, interaction.token, "update", () =>
        executeConfirm(ctx, poll, server, (args[0] ?? "").split(".").map(Number)),
      );
    case "confirm":
      // 以前の 1 日だけ確定するボタン（開いたままのもの）からの操作
      return update({ content: "確定の画面が新しくなりました。[📋 詳細] から開き直してください。" });
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

/** 予定の重なりを調べる範囲。候補日は 2 年先までで、所要時間は最長 7 日 */
function busyWindow(now: number): [number, number] {
  return [now - 7 * DAY_SECONDS, now + MAX_AHEAD_SECONDS + 7 * DAY_SECONDS];
}
const DAY_SECONDS = 24 * 60 * 60;

/**
 * 回答パネルを開く: 日程調整・サーバー設定・候補日・回答・本人の他の予定を並行して読む（DB との往復 1 回）。
 * 予定の範囲は候補日を読む前に決める必要があるので、候補日になりうる範囲全体で読み、候補ごとに絞る。
 */
async function openVotePanel(
  ctx: Context,
  pollId: number,
  guildId: string,
  userId: string,
  page: number,
): Promise<MessageBody> {
  const [from, to] = busyWindow(ctx.now);
  const [poll, server, candidates, votes, busy] = await Promise.all([
    getPoll(ctx.env.DB, pollId),
    getServerOrDefault(ctx.env.DB, guildId),
    listCandidates(ctx.env.DB, pollId),
    listVotes(ctx.env.DB, pollId),
    collectBusy(ctx.env, userId, from, to, { pollId }),
  ]);
  if (!poll || poll.guild_id !== guildId) return { content: GONE, embeds: [], components: [] };
  if (poll.state !== "open") return { content: "この日程調整は受付を終了しています。", embeds: [], components: [] };
  return buildPanel(ctx, poll, server, userId, page, candidates, votes, busy);
}

/** 回答パネル: 本人の今の回答と、候補ごとの予定の重なりを出す（日程調整は確認済みのもの） */
async function votePanel(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  userId: string,
  page: number,
): Promise<MessageBody> {
  const [from, to] = busyWindow(ctx.now);
  const [candidates, votes, busy] = await Promise.all([
    listCandidates(ctx.env.DB, poll.id),
    listVotes(ctx.env.DB, poll.id),
    collectBusy(ctx.env, userId, from, to, { pollId: poll.id }),
  ]);
  return buildPanel(ctx, poll, server, userId, page, candidates, votes, busy);
}

async function buildPanel(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  userId: string,
  page: number,
  candidates: CandidateRow[],
  votes: VoteRow[],
  busy: Busy[],
): Promise<MessageBody> {
  const myVotes = new Map<number, VoteValue>(
    votes.filter((v) => v.user_id === userId).map((v) => [v.candidate_id, v.value]),
  );
  const conflicts = new Map<number, Busy[]>(
    candidates.map((c) => [c.id, overlapping(busy, { start: c.start_at, end: c.start_at + poll.duration_minutes * 60 })]),
  );
  // サーバー名は、重なった予定があるときだけ取りに行く
  const guildNames = await fetchGuildNames(
    ctx.env,
    [...conflicts.values()].flat().map((b) => b.guild_id),
  );

  return buildVotePanel({
    poll,
    candidates,
    myVotes,
    conflicts,
    guildNames,
    timezone: server.timezone,
    now: ctx.now,
    page,
  });
}

/** 1 つの候補日への回答。今と同じボタンを押したら取り消し（➖）にする */
async function saveVote(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  userId: string,
  candidateId: number,
  value: VoteValue,
  page: number,
  interactionId: string,
): Promise<MessageBody> {
  const [candidates, votes] = await Promise.all([listCandidates(ctx.env.DB, poll.id), listVotes(ctx.env.DB, poll.id)]);
  const candidate = candidates.find((c) => c.id === candidateId);
  // 開始済みの候補は締め切り。ボタンにも出していないが、古いパネルからの操作に備えてここでも弾く
  if (candidate && candidate.start_at > ctx.now) {
    const current = votes.find((v) => v.candidate_id === candidateId && v.user_id === userId)?.value;
    const next = current === value ? null : value;
    await setVote(ctx.env.DB, candidateId, userId, next, ctx.now, interactionTime(interactionId));

    // 公開の投票メッセージの書き換えは、本人の回答パネルの更新を待たせないよう並行して進める
    ctx.exec.waitUntil(
      refreshPollMessage(ctx, poll).catch((err) => logError("refresh poll message failed", err)),
    );
  }
  return votePanel(ctx, poll, server, userId, page);
}

/**
 * すぐ返したパネルの回答を保存する。value は押した後の回答（null は取り消し）。トグルの判定はパネル側で済ませている。
 * 応答の前には何も確認していないので、ここで日程調整（別サーバーのものでないか・受付中か）と候補日を確かめる。
 * 受け付けられなければ保存せず、パネルを案内や DB の状態に戻す。
 * 保存の順番が前後しても、押した時刻が最も新しい回答が残る（`setVote`）。
 */
async function persistVote(
  ctx: Context,
  pollId: number,
  interaction: APIMessageComponentGuildInteraction,
  vote: { candidateId: number; value: VoteValue | null; page: number },
): Promise<void> {
  const [poll, server] = await Promise.all([
    getPoll(ctx.env.DB, pollId),
    getServerOrDefault(ctx.env.DB, interaction.guild_id),
  ]);
  const reject = (content: string) => editOriginal(ctx.env, interaction.token, { content, embeds: [], components: [] });
  if (!poll || poll.guild_id !== interaction.guild_id) return void (await reject(GONE));
  if (poll.state !== "open") return void (await reject("この日程調整は受付を終了しています。"));

  const userId = interaction.member.user.id;
  const candidates = await listCandidates(ctx.env.DB, poll.id);
  const candidate = candidates.find((c) => c.id === vote.candidateId);
  if (!candidate || candidate.start_at <= ctx.now) {
    await editOriginal(ctx.env, interaction.token, await votePanel(ctx, poll, server, userId, vote.page));
    return;
  }
  // 後から押した分がもう保存されていれば、この回答は捨てる（投票メッセージの描き直しもそちらに任せる）
  if (await setVote(ctx.env.DB, vote.candidateId, userId, vote.value, ctx.now, interactionTime(interaction.id))) {
    await refreshPollMessage(ctx, poll);
  }
}

/** 選んだ候補のうち、まだ始まっていないものを日時順に。選べないものが混ざっていれば null */
function pickedCandidates(candidates: CandidateRow[], picked: (c: CandidateRow) => boolean, count: number, now: number) {
  const chosen = candidates.filter(picked);
  if (chosen.length === 0 || chosen.length !== count || chosen.some((c) => c.start_at <= now)) return null;
  return chosen;
}

function confirmPick(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  candidates: CandidateRow[],
  votes: VoteRow[],
  candidateIds: number[],
): APIInteractionResponse {
  const ids = new Set(candidateIds);
  const chosen = pickedCandidates(candidates, (c) => ids.has(c.id), ids.size, ctx.now);
  if (!chosen) return update({ content: "その候補日は選べません。" });
  const tally = tallyVotes(candidates, votes);
  const range = (c: CandidateRow) => formatRange(c.start_at, poll.duration_minutes, server.timezone, ctx.now);

  let content: string[];
  if (chosen.length === 1) {
    const t = tally.get(chosen[0]!.id)!;
    content = [
      `「${poll.title}」を **${range(chosen[0]!)}** で確定しますか？`,
      `この日に ⭕ の ${t.yes.length} 人は「参加」、🔺 の ${t.maybe.length} 人は「未定」、❌ の ${t.no.length} 人は「不参加」として引き継ぎます。`,
      "投票メッセージは確定イベントの告知に切り替わり、リマインドの対象になります。候補日ごとの投票データは削除されます。",
    ];
  } else {
    content = [
      `「${poll.title}」を次の ${chosen.length} 日間で確定しますか？`,
      ...chosen.map((c) => `・**${range(c)}**　${tallyText(tally.get(c.id)!)}`),
      "日程ごとに、⭕ の人は「参加」、🔺 の人は「未定」、❌ の人は「不参加」として引き継ぎます。",
      "日程ごとに告知メッセージを投稿し（それぞれがリマインドの対象になります）、投票メッセージは確定した日程の一覧に切り替わります。候補日ごとの投票データは削除されます。",
    ];
  }
  return update({
    content: content.join("\n"),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Success,
            custom_id: `poll:fix:${poll.id}:${chosen.map((c) => c.position).join(".")}`,
            label: chosen.length === 1 ? "確定する" : `${chosen.length} 日間で確定する`,
          },
        ],
      },
    ],
  });
}

async function executeConfirm(
  ctx: Context,
  poll: PollRow,
  server: ServerRow,
  positions: number[],
): Promise<MessageBody> {
  const candidates = await listCandidates(ctx.env.DB, poll.id);
  const wanted = new Set(positions);
  const chosen = pickedCandidates(candidates, (c) => wanted.has(c.position), wanted.size, ctx.now);
  if (!chosen) return { content: "その候補日は選べません。", components: [] };

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
  const whenOf = (c: CandidateRow) => formatRange(c.start_at, poll.duration_minutes, server.timezone, ctx.now);
  const headerOf = (c: CandidateRow) => {
    const dateLine = `日時　${whenOf(c)}`;
    return pollHeader ? pollHeaderToEventHeader(pollHeader, dateLine) : dateLine;
  };
  return chosen.length === 1
    ? confirmOne(ctx, poll, chosen[0]!, pollHeader, whenOf, headerOf)
    : confirmMany(ctx, poll, chosen, pollHeader, whenOf, headerOf);
}

/** 1 日だけの確定: 投票メッセージをそのまま確定イベントの告知にする */
async function confirmOne(
  ctx: Context,
  poll: PollRow,
  candidate: CandidateRow,
  pollHeader: string | undefined,
  whenOf: (c: CandidateRow) => string,
  headerOf: (c: CandidateRow) => string,
): Promise<MessageBody> {
  const eventIds = await confirmPoll(ctx.env.DB, poll, [{ candidate, messageId: poll.message_id }], ctx.now);
  if (eventIds === null) return { content: "この日程調整はすでに確定または中止されています。", components: [] };
  const event = (await getEvent(ctx.env.DB, eventIds[0]!))!;

  let note = "";
  if (event.message_id && pollHeader !== undefined) {
    const responses = await listResponses(ctx.env.DB, event.id);
    await discordRequest(ctx.env, "PATCH", `/channels/${event.channel_id}/messages/${event.message_id}`, {
      body: buildAnnouncement(event, headerOf(candidate), responses),
    });
  } else {
    note = "\n（投票メッセージが見つからなかったため、告知メッセージは更新していません。）";
  }
  return { content: `✅ 「${poll.title}」を ${whenOf(candidate)} で確定しました。${note}`, embeds: [], components: [] };
}

/**
 * 複数日の確定: 日程ごとに告知メッセージを投稿し、投票メッセージは確定した日程の一覧にする。
 * 告知はイベントを作る前に（ボタンなしで）投稿しておく。投稿できなければ日程調整はそのまま残す。
 */
async function confirmMany(
  ctx: Context,
  poll: PollRow,
  chosen: CandidateRow[],
  pollHeader: string | undefined,
  whenOf: (c: CandidateRow) => string,
  headerOf: (c: CandidateRow) => string,
): Promise<MessageBody> {
  const draft = (c: CandidateRow): EventRow => ({
    id: 0,
    guild_id: poll.guild_id,
    channel_id: poll.channel_id,
    message_id: null,
    title: poll.title,
    start_at: c.start_at,
    duration_minutes: poll.duration_minutes,
    state: "scheduled",
  });
  const messagePath = (id: string) => `/channels/${poll.channel_id}/messages/${id}`;
  const removePosted = (ids: string[]) =>
    Promise.all(ids.map((id) => discordRequest(ctx.env, "DELETE", messagePath(id)).catch(() => undefined)));

  const posted: string[] = [];
  try {
    for (const c of chosen) {
      const message = await discordRequest<APIMessage>(ctx.env, "POST", `/channels/${poll.channel_id}/messages`, {
        body: { ...buildAnnouncement(draft(c), headerOf(c), []), components: [] },
      });
      posted.push(message.id);
    }
  } catch (err) {
    await removePosted(posted);
    if (
      isDiscordError(err, DiscordErrorCode.MissingAccess, DiscordErrorCode.MissingPermissions, DiscordErrorCode.UnknownChannel)
    ) {
      return { content: `${cannotPostMessage(poll.channel_id)}\n日程調整は確定せずに残しています。`, components: [] };
    }
    throw err;
  }

  const picks = chosen.map((candidate, i) => ({ candidate, messageId: posted[i]! }));
  const eventIds = await confirmPoll(ctx.env.DB, poll, picks, ctx.now);
  if (eventIds === null) {
    await removePosted(posted);
    return { content: "この日程調整はすでに確定または中止されています。", components: [] };
  }

  // 告知に、確定イベントの回答とボタンを入れる
  const lines: string[] = [];
  for (const [i, c] of chosen.entries()) {
    const event = (await getEvent(ctx.env.DB, eventIds[i]!))!;
    const responses = await listResponses(ctx.env.DB, event.id);
    await discordRequest(ctx.env, "PATCH", messagePath(posted[i]!), {
      body: buildAnnouncement(event, headerOf(c), responses),
    });
    lines.push(`・[${whenOf(c)}](${messageLink(poll.guild_id, poll.channel_id, posted[i]!)})`);
  }

  let note = "";
  if (poll.message_id && pollHeader !== undefined) {
    await discordRequest(ctx.env, "PATCH", messagePath(poll.message_id), {
      body: buildConfirmedPollMessage(poll, pollHeader, lines),
    });
  } else {
    note = "\n（投票メッセージが見つからなかったため、投票メッセージは更新していません。）";
  }
  return {
    content: `✅ 「${poll.title}」を ${chosen.length} 日間で確定し、日程ごとに告知を投稿しました。\n${lines.join("\n")}${note}`,
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
    const [candidates, votes, server] = await Promise.all([
      listCandidates(ctx.env.DB, poll.id),
      listVotes(ctx.env.DB, poll.id),
      getServerOrDefault(ctx.env.DB, poll.guild_id),
    ]);
    await discordRequest(ctx.env, "PATCH", path, {
      body: buildPollMessage(poll, header, candidates, votes, server.timezone, ctx.now),
    });
  } catch (err) {
    if (isDiscordError(err, DiscordErrorCode.UnknownMessage, DiscordErrorCode.UnknownChannel)) {
      await transitionPollState(ctx.env.DB, poll.id, "open", "message_deleted");
      return;
    }
    throw err;
  }
}
