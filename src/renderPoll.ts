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
import { formatDateTime, formatRange } from "./time";

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
  return VOTE_VALUES.map((v) => `${VOTE_MARK[v]}${t[v].length}`).join(" ");
}

// ---- 公開の投票メッセージ（日付ごとの一覧） ----

/** 埋め込み全体の文字数上限（6000）に、タイトルや本文のぶんの余裕を見た値 */
const EMBED_TEXT_LIMIT = 5800;
/** 埋め込みのフィールド値の上限 */
const FIELD_VALUE_LIMIT = 1024;

/** 「⭕ 3　<@a> <@b> …」の 1 行。フィールドに収まらない分は「他n人」にする */
function voteLine(mark: string, userIds: string[], withNames: boolean, maxLength: number): string {
  const head = `${mark} ${userIds.length}`;
  if (!withNames || userIds.length === 0) return head;
  let line = `${head}　`;
  let shown = 0;
  for (const id of userIds) {
    const piece = (shown ? " " : "") + mention(id);
    if (line.length + piece.length > maxLength - 10) break;
    line += piece;
    shown++;
  }
  return shown < userIds.length ? `${line} 他${userIds.length - shown}人` : line;
}

/**
 * 候補日ごとに 1 フィールド。見出しが日付で、中身は記号ごとに 1 行（⭕ 🔺 ❌ ➖）。
 * 名前が折り返しても、行頭の記号でどの回答かが分かるようにする。
 * 名前は埋め込みの文字数上限に収まる範囲で出す（全員 → ⭕🔺 だけ → 人数だけ）。
 */
export function buildVoteListFields(
  poll: Pick<PollRow, "duration_minutes">,
  candidates: CandidateRow[],
  votes: VoteRow[],
  timezone: string,
  now: number,
  budget = EMBED_TEXT_LIMIT,
): { fields: APIEmbedField[]; namesOmitted: boolean } {
  if (votes.length === 0) {
    const dates = candidates.map((c) => `・${candidateRange(c, poll, timezone, now)}${c.start_at <= now ? "（終了）" : ""}`);
    return {
      fields: [
        { name: "候補日", value: `${dates.join("\n")}\n\nまだ回答はありません。[🗳️ 回答する] から回答してください。` },
      ],
      namesOmitted: false,
    };
  }
  const tally = tallyVotes(candidates, votes);
  const voters = [...new Set(votes.map((v) => v.user_id))];
  const bestYes = Math.max(0, ...[...tally.values()].map((t) => t.yes.length));

  const build = (named: VoteValue[]): APIEmbedField[] =>
    candidates.map((c) => {
      const t = tally.get(c.id)!;
      const answered = new Set([...t.yes, ...t.maybe, ...t.no]);
      const unanswered = voters.filter((u) => !answered.has(u));
      const lines = [
        voteLine(VOTE_MARK.yes, t.yes, named.includes("yes"), FIELD_VALUE_LIMIT / 2),
        voteLine(VOTE_MARK.maybe, t.maybe, named.includes("maybe"), FIELD_VALUE_LIMIT / 4),
      ];
      if (t.no.length > 0) lines.push(voteLine(VOTE_MARK.no, t.no, named.includes("no"), FIELD_VALUE_LIMIT / 8));
      if (unanswered.length > 0) {
        lines.push(voteLine(NO_VOTE_MARK, unanswered, named.includes("no"), FIELD_VALUE_LIMIT / 8));
      }
      const best = bestYes > 0 && t.yes.length === bestYes ? " ⭐" : "";
      const ended = c.start_at <= now ? "（終了）" : "";
      return { name: `${candidateRange(c, poll, timezone, now)}${ended}${best}`, value: lines.join("\n") };
    });
  const size = (fields: APIEmbedField[]) => fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

  for (const named of [VOTE_VALUES, ["yes", "maybe"] as VoteValue[]]) {
    const fields = build(named);
    if (size(fields) <= budget) return { fields, namesOmitted: named.length < VOTE_VALUES.length };
  }
  return { fields: build([]), namesOmitted: true };
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
  const cancelled = poll.state === "cancelled";
  const title = `${cancelled ? "【中止】" : ""}🗳️ ${poll.title}（日程調整）`;
  const voters = new Set(votes.map((v) => v.user_id)).size;
  const legend = `${VOTE_MARK.yes} 参加できる　${VOTE_MARK.maybe} たぶん　${VOTE_MARK.no} 参加できない　${NO_VOTE_MARK} 未回答`;
  const footerFor = (namesOmitted: boolean) =>
    [`回答 ${voters}人`, ...(cancelled ? [] : [legend]), ...(namesOmitted ? ["名前は [📋 詳細] で確認できます"] : [])].join(
      " ・ ",
    );
  const { fields, namesOmitted } = buildVoteListFields(
    poll,
    candidates,
    votes,
    timezone,
    now,
    EMBED_TEXT_LIMIT - title.length - header.length - footerFor(true).length,
  );
  const embed: APIEmbed = {
    title,
    description: header,
    color: cancelled ? COLOR_CANCELLED : COLOR_OPEN,
    fields,
    footer: { text: footerFor(namesOmitted) },
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

/** 複数日で確定したあとの投票メッセージ: 確定した日程（各告知へのリンク）の一覧。ボタンは外す */
export function buildConfirmedPollMessage(poll: Pick<PollRow, "title">, pollHeader: string, dateLinks: string[]) {
  const rest = pollHeader
    .split("\n")
    .filter((line) => !line.startsWith("所要時間　"))
    .join("\n");
  return {
    embeds: [
      {
        title: `✅ ${poll.title}（日程確定）`,
        description: `**確定した日程**\n${dateLinks.join("\n")}${rest ? `\n\n${rest}` : ""}`,
        color: COLOR_OPEN,
        footer: { text: "参加・未定・不参加は、日程ごとの告知メッセージのボタンで回答してください" },
      },
    ],
    components: [],
    allowed_mentions: { parse: [] },
  };
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
 * 回答パネル。候補日ごとに 1 行で [日付] [⭕] [🔺] [❌] を並べ、今の回答のボタンに色を付ける。
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
        ? "候補日ごとに ⭕（参加できる）・🔺（たぶん）・❌（参加できない）を押してください。押すとすぐ保存され、色の付いたボタンが今の回答です。\n" +
          "同じボタンをもう一度押すと取り消して「➖（未回答）」に戻ります。"
        : "回答を受け付けている候補日はありません。",
    embeds: [embed],
    components: rows,
    allowed_mentions: { parse: [] },
  };
}

/**
 * 回答パネルのボタンが押されたとき、DB を待たずにすぐ返すための見た目の更新。
 * 押されたメッセージ（今のパネル）のうち、その行のボタンの色と、上の一覧の「あなた: 」の記号だけを書き換える。
 * 今と同じ記号なら取り消し（null）。パネルが想定した形でなければ null を返す（呼び出し側は DB から作り直す）。
 */
export function applyVoteToPanel(
  message: { embeds?: APIEmbed[]; components?: unknown[] },
  customId: string,
): { value: VoteValue | null; body: { embeds: APIEmbed[]; components: APIActionRowComponent<APIComponentInMessageActionRow>[] } } | null {
  const [, , , , pressed, pageText] = customId.split(":");
  if (!VOTE_VALUES.includes(pressed as VoteValue)) return null;
  const rows = (message.components ?? []) as APIActionRowComponent<APIButtonComponentWithCustomId>[];
  const hasPrefix = (row: APIActionRowComponent<APIButtonComponentWithCustomId>, prefix: string) =>
    row.type === ComponentType.ActionRow && row.components.some((c) => c.custom_id?.startsWith(prefix));
  const voteRows = rows.filter((row) => hasPrefix(row, "poll:v:"));
  const rowIndex = voteRows.findIndex((row) => row.components.some((c) => c.custom_id === customId));
  if (rowIndex < 0) return null;

  const voteOf = (c: APIButtonComponentWithCustomId) => c.custom_id.split(":")[4] as VoteValue;
  const current = voteRows[rowIndex]!.components.find(
    (c) => c.custom_id.startsWith("poll:v:") && c.style !== ButtonStyle.Secondary,
  );
  const value = current && voteOf(current) === pressed ? null : (pressed as VoteValue);

  // 上の一覧で、押された候補日の行を探す（終了した候補日と重なりの行を除いた、受付中の候補日の並び）
  const embed = message.embeds?.[0];
  if (!embed?.description) return null;
  const lines = embed.description.split("\n");
  const openLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !line.startsWith("　└") && !line.endsWith("（終了）"));
  const paged = rows.some((row) => hasPrefix(row, "poll:page:"));
  const target = openLines[(paged ? (Number(pageText) || 0) * ROWS_PER_PAGE : 0) + rowIndex];
  if (!target || !/あなた: \S+$/.test(target.line)) return null;
  lines[target.i] = target.line.replace(/あなた: \S+$/, `あなた: ${value ? VOTE_MARK[value] : NO_VOTE_MARK}`);

  const components = rows.map((row) =>
    row.components.some((c) => c.custom_id === customId)
      ? {
          ...row,
          components: row.components.map((c) =>
            c.custom_id.startsWith("poll:v:")
              ? { ...c, style: voteOf(c) === value ? SELECTED_STYLE[value] : ButtonStyle.Secondary }
              : c,
          ),
        }
      : row,
  );
  return {
    value,
    body: {
      embeds: [{ title: embed.title, description: lines.join("\n"), footer: embed.footer && { text: embed.footer.text } }],
      components: components as APIActionRowComponent<APIComponentInMessageActionRow>[],
    },
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
            placeholder: "✅ 確定する日を選ぶ（複数選べます・運営者）",
            min_values: 1,
            max_values: future.length,
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
