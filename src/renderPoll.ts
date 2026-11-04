import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
} from "discord-api-types/v10";
import { formatBusyLine, NO_VOTE_MARK, VOTE_MARK, type Busy } from "./conflicts";
import type { CandidateRow, PollRow, VoteRow, VoteValue } from "./db/polls";
import { mention } from "./render";
import { formatDateTime, formatRange, formatTableDate } from "./time";

const COLOR_OPEN = 0x57f287;
const COLOR_CANCELLED = 0x80848e;

export const VOTE_VALUES: VoteValue[] = ["yes", "maybe", "no"];
const VOTE_LABEL: Record<VoteValue, string> = { yes: "参加できる", maybe: "たぶん", no: "参加できない" };

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}時間${m > 0 ? `${m}分` : ""}` : `${m}分`;
}

export function candidateRange(
  c: CandidateRow,
  poll: Pick<PollRow, "duration_minutes">,
  timezone: string,
  now?: number,
): string {
  return formatRange(c.start_at, poll.duration_minutes, timezone, now);
}

/** 投票メッセージ本文（所要時間・場所・主催・説明）。作成時にだけ作り、以後はメッセージ側を正とする。 */
export function buildPollHeader(opts: {
  durationMinutes: number;
  location?: string;
  hostId: string;
  description?: string;
}): string {
  const lines = [`所要時間　${formatDuration(opts.durationMinutes)}`];
  if (opts.location) lines.push(`場所　${opts.location}`);
  lines.push(`主催　${mention(opts.hostId)}`);
  let text = lines.join("\n");
  if (opts.description) text += `\n\n${opts.description}`;
  return text;
}

/** 確定時: 投票メッセージの本文を確定イベントの本文に書き換える（所要時間の行を日時の行に置き換える） */
export function pollHeaderToEventHeader(pollHeader: string, dateLine: string): string {
  const rest = pollHeader
    .split("\n")
    .filter((line) => !line.startsWith("所要時間　"))
    .join("\n");
  return `${dateLine}\n${rest}`;
}

export type Tally = Record<VoteValue, string[]>;

export function tallyVotes(candidates: CandidateRow[], votes: VoteRow[]): Map<number, Tally> {
  const tally = new Map<number, Tally>(candidates.map((c) => [c.id, { yes: [], maybe: [], no: [] }]));
  for (const v of votes) tally.get(v.candidate_id)?.[v.value].push(v.user_id);
  return tally;
}

export function tallyText(t: Tally): string {
  return `〇${t.yes.length} △${t.maybe.length} ×${t.no.length}`;
}

// ---- 公開の投票メッセージ（表） ----

/** 表の列見出し。全角にして、〇△×－ と幅をそろえる */
const MEMBER_LETTERS = "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲ";
/** 1 つの表に並べる人数（スマホの画面幅で折り返さないように） */
export const MEMBERS_PER_TABLE = 6;
/** 表に載せる最大人数（埋め込みの文字数上限のため。超えた分は「詳細」で見る） */
export const MAX_TABLE_MEMBERS = MEMBER_LETTERS.length;
/** 日付列「11/12(水)19:00」の表示幅（半角換算） */
const DATE_COLUMN_WIDTH = 14;

/** 回答した人を、最初に回答した順に並べる（回答を変えても列は動かない） */
export function orderVoters(votes: VoteRow[]): string[] {
  const first = new Map<string, number>();
  for (const v of votes) {
    const t = first.get(v.user_id);
    if (t === undefined || v.created_at < t) first.set(v.user_id, v.created_at);
  }
  return [...first.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/**
 * 縦が候補日、横がメンバーの表。セルは 〇 △ × と、未回答の －。
 * コードブロックの等幅表示でそろえ、列見出しは Ａ Ｂ Ｃ…、誰がどの列かは表の下に名前（メンション）で出す。
 */
export function buildVoteTableFields(
  candidates: CandidateRow[],
  votes: VoteRow[],
  timezone: string,
  now: number,
): APIEmbedField[] {
  const voters = orderVoters(votes);
  if (voters.length === 0) {
    return [{ name: "回答状況", value: "まだ回答はありません。[🗳️ 回答する] から回答してください。" }];
  }
  const shown = voters.slice(0, MAX_TABLE_MEMBERS);
  const cell = new Map<string, VoteValue>(votes.map((v) => [`${v.candidate_id}:${v.user_id}`, v.value]));

  const fields: APIEmbedField[] = [];
  for (let from = 0; from < shown.length; from += MEMBERS_PER_TABLE) {
    const group = shown.slice(from, from + MEMBERS_PER_TABLE);
    const letters = [...MEMBER_LETTERS].slice(from, from + group.length);
    const lines = [`${" ".repeat(DATE_COLUMN_WIDTH)} ${letters.join("")}`];
    for (const c of candidates) {
      const cells = group
        .map((u) => {
          const v = cell.get(`${c.id}:${u}`);
          return v ? VOTE_MARK[v] : NO_VOTE_MARK;
        })
        .join("");
      lines.push(`${formatTableDate(c.start_at, timezone)} ${cells}${c.start_at <= now ? " 終了" : ""}`);
    }
    const range =
      shown.length <= MEMBERS_PER_TABLE ? "" : letters.length === 1 ? `（${letters[0]}）` : `（${letters[0]}〜${letters.at(-1)}）`;
    fields.push({ name: `回答状況${range}`, value: "```\n" + lines.join("\n") + "\n```" });
  }

  let legend = shown.map((u, i) => `${[...MEMBER_LETTERS][i]} ${mention(u)}`).join("　");
  if (voters.length > shown.length) {
    legend += `\n他 ${voters.length - shown.length} 人の回答は [📋 詳細] で確認できます`;
  }
  fields.push({ name: "メンバー", value: legend });
  return fields;
}

/** 公開の投票メッセージ */
export function buildPollMessage(
  poll: PollRow,
  header: string,
  candidates: CandidateRow[],
  votes: VoteRow[],
  timezone: string,
  now: number,
) {
  const tally = tallyVotes(candidates, votes);
  const fields = buildVoteTableFields(candidates, votes, timezone, now);

  const bestYes = Math.max(0, ...[...tally.values()].map((t) => t.yes.length));
  if (bestYes > 0) {
    const best = candidates
      .filter((c) => tally.get(c.id)!.yes.length === bestYes)
      .map((c) => `${candidateRange(c, poll, timezone, now)}（${tallyText(tally.get(c.id)!)}）`);
    fields.push({ name: "⭐ 〇が多い日", value: best.join("\n") });
  }

  const voters = new Set(votes.map((v) => v.user_id)).size;
  const cancelled = poll.state === "cancelled";
  const embed: APIEmbed = {
    title: `${cancelled ? "【中止】" : ""}🗳️ ${poll.title}（日程調整）`,
    description: header,
    color: cancelled ? COLOR_CANCELLED : COLOR_OPEN,
    fields,
    footer: {
      text: cancelled
        ? `回答 ${voters}人`
        : `回答 ${voters}人 ・ 〇 参加できる　△ たぶん　× 参加できない　－ 未回答`,
    },
  };
  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] =
    poll.state === "open"
      ? [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Primary,
                custom_id: `poll:vote:${poll.id}`,
                label: "回答する",
                emoji: { name: "🗳️" },
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                custom_id: `poll:detail:${poll.id}`,
                label: "詳細",
                emoji: { name: "📋" },
              },
            ],
          },
        ]
      : [];
  return { embeds: [embed], components, allowed_mentions: { parse: [] } };
}

// ---- 本人にだけ見える回答パネル ----

/** 1 メッセージに置けるボタンの行は 5 つまで。候補が 5 つを超えたら 4 行ずつに分け、最後の行をページ送りにする */
const MAX_ROWS = 5;
const ROWS_PER_PAGE = MAX_ROWS - 1;

export function pageCount(openCount: number): number {
  return openCount <= MAX_ROWS ? 1 : Math.ceil(openCount / ROWS_PER_PAGE);
}

const SELECTED_STYLE: Record<VoteValue, APIButtonComponentWithCustomId["style"]> = {
  yes: ButtonStyle.Success,
  maybe: ButtonStyle.Primary,
  no: ButtonStyle.Danger,
};

/**
 * 回答パネル。候補日ごとに 1 行で [日付] [〇] [△] [×] を並べ、今の回答のボタンに色を付ける。
 * 上の一覧には、候補日ごとに本人の他の予定との重なりを出す。
 */
export function buildVotePanel(opts: {
  poll: PollRow;
  candidates: CandidateRow[];
  myVotes: Map<number, VoteValue>;
  conflicts: Map<number, Busy[]>;
  guildNames: Map<string, string>;
  timezone: string;
  now: number;
  page: number;
}) {
  const { poll, candidates, myVotes, conflicts, guildNames, timezone, now } = opts;
  const open = candidates.filter((c) => c.start_at > now);
  const pages = pageCount(open.length);
  const page = Math.min(Math.max(opts.page, 0), pages - 1);
  const onPage = pages === 1 ? open : open.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);

  const lines: string[] = [];
  for (const c of candidates) {
    const my = myVotes.get(c.id);
    const ended = c.start_at <= now ? "（終了）" : "";
    lines.push(`${candidateRange(c, poll, timezone, now)}　あなた: ${my ? VOTE_MARK[my] : NO_VOTE_MARK}${ended}`);
    for (const b of conflicts.get(c.id) ?? []) lines.push(`　└ ⚠️ ${formatBusyLine(b, guildNames, now)}`);
  }
  const conflictCount = [...conflicts.values()].filter((l) => l.length > 0).length;
  let description = lines.join("\n");
  if (description.length > 3900) description = `${description.slice(0, 3900)}\n…`;

  const embed: APIEmbed = {
    title: `🗳️ ${poll.title} の回答`,
    description,
    footer: {
      text:
        conflictCount > 0
          ? `⚠️ ${conflictCount} 件の候補日が、この bot で管理しているあなたの他の予定と重なっています`
          : "この bot で管理しているあなたの他の予定とは重なっていません",
    },
  };

  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = onPage.map((c) => {
    const my = myVotes.get(c.id);
    const busy = (conflicts.get(c.id) ?? []).length > 0;
    const label: APIButtonComponentWithCustomId = {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      custom_id: `poll:label:${poll.id}:${c.id}`,
      label: `${formatDateTime(c.start_at, timezone, now)}${busy ? " ⚠️" : ""}`,
      disabled: true,
    };
    const voteButtons: APIButtonComponentWithCustomId[] = VOTE_VALUES.map((v) => ({
      type: ComponentType.Button,
      style: my === v ? SELECTED_STYLE[v] : ButtonStyle.Secondary,
      custom_id: `poll:v:${poll.id}:${c.id}:${v}:${page}`,
      label: VOTE_MARK[v],
    }));
    return { type: ComponentType.ActionRow, components: [label, ...voteButtons] };
  });

  if (pages > 1) {
    rows.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          custom_id: `poll:page:${poll.id}:${page - 1}`,
          label: "◀ 前へ",
          disabled: page === 0,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          custom_id: `poll:pageinfo:${poll.id}`,
          label: `${page + 1} / ${pages}`,
          disabled: true,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          custom_id: `poll:page:${poll.id}:${page + 1}`,
          label: "次へ ▶",
          disabled: page === pages - 1,
        },
      ],
    });
  }

  return {
    content:
      open.length > 0
        ? "候補日ごとに 〇（参加できる）・△（たぶん）・×（参加できない）を押してください。押すとすぐ保存され、色の付いたボタンが今の回答です。\n" +
          "同じボタンをもう一度押すと取り消して「－（未回答）」に戻ります。"
        : "回答を受け付けている候補日はありません。",
    embeds: [embed],
    components: rows,
    allowed_mentions: { parse: [] },
  };
}

// ---- 詳細（全員の回答と、運営者の操作） ----

export function buildPollDetail(opts: {
  poll: PollRow;
  candidates: CandidateRow[];
  votes: VoteRow[];
  timezone: string;
  isOperator: boolean;
  now: number;
}) {
  const { poll, candidates, votes, timezone, isOperator, now } = opts;
  const tally = tallyVotes(candidates, votes);
  let description = "";
  for (const c of candidates) {
    const t = tally.get(c.id)!;
    const block =
      `**${candidateRange(c, poll, timezone, now)}**\n` +
      VOTE_VALUES.map((v) => `${VOTE_MARK[v]} ${VOTE_LABEL[v]} (${t[v].length}) ${t[v].map(mention).join(" ") || "—"}`).join(
        "\n",
      ) +
      "\n\n";
    if (description.length + block.length > 3900) {
      description += "…（多すぎるため省略）";
      break;
    }
    description += block;
  }

  const components: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  const future = candidates.filter((c) => c.start_at > now);
  if (isOperator && poll.state === "open") {
    if (future.length > 0) {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: `poll:pick:${poll.id}`,
            placeholder: "✅ 確定する日を選ぶ（運営者）",
            options: future.map((c) => ({
              label: `${formatDateTime(c.start_at, timezone, now)}　${tallyText(tally.get(c.id)!)}`,
              value: String(c.id),
            })),
          },
        ],
      });
    }
    components.push({
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Danger, custom_id: `poll:cancel:${poll.id}`, label: "日程調整を中止（運営者）" },
      ],
    });
  }

  return {
    embeds: [{ title: `🗳️ ${poll.title} の回答一覧`, description: description.trim() || "—" }],
    components,
    allowed_mentions: { parse: [] },
  };
}
