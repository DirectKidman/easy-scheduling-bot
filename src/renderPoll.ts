import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
  type APISelectMenuOption,
} from "discord-api-types/v10";
import { formatBusyLine, formatBusyShort, VOTE_MARK, type Busy } from "./conflicts";
import type { CandidateRow, PollRow, VoteRow, VoteValue } from "./db/polls";
import { mention } from "./render";
import { formatLocalShort } from "./time";

const COLOR_OPEN = 0x57f287;
const COLOR_CANCELLED = 0x80848e;
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

export function candidateLabel(c: Pick<CandidateRow, "position">): string {
  return CIRCLED[c.position - 1] ?? `(${c.position})`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}時間${m > 0 ? `${m}分` : ""}` : `${m}分`;
}

export function candidateRange(c: CandidateRow, poll: Pick<PollRow, "duration_minutes">): string {
  const end = c.start_at + poll.duration_minutes * 60;
  return `<t:${c.start_at}:f>〜<t:${end}:${poll.duration_minutes >= 24 * 60 ? "f" : "t"}>`;
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

export interface Tally {
  yes: string[];
  maybe: string[];
}

export function tallyVotes(candidates: CandidateRow[], votes: VoteRow[]): Map<number, Tally> {
  const tally = new Map<number, Tally>(candidates.map((c) => [c.id, { yes: [], maybe: [] }]));
  for (const v of votes) tally.get(v.candidate_id)?.[v.value].push(v.user_id);
  return tally;
}

function mentionList(ids: string[], limit: number): string {
  const shown = ids.slice(0, limit).map(mention).join(" ");
  return ids.length > limit ? `${shown} 他${ids.length - limit}人` : shown;
}

/** 公開の投票メッセージ */
export function buildPollMessage(
  poll: PollRow,
  header: string,
  candidates: CandidateRow[],
  votes: VoteRow[],
  now: number,
) {
  const tally = tallyVotes(candidates, votes);
  const bestYes = Math.max(0, ...[...tally.values()].map((t) => t.yes.length));
  // 埋め込み全体の文字数上限（6000）に収めるため、候補が多いときは名前を省いて人数だけにする
  const mentionLimit = candidates.length <= 5 ? 10 : candidates.length <= 10 ? 5 : 0;

  const fields: APIEmbedField[] = candidates.map((c) => {
    const t = tally.get(c.id)!;
    // 先頭に付けると候補番号の位置がずれるので、行末に付ける
    const star = bestYes > 0 && t.yes.length === bestYes ? "　⭐" : "";
    const ended = c.start_at <= now ? "（終了）" : "";
    let value = candidateRange(c, poll);
    if (mentionLimit > 0) {
      if (t.yes.length) value += `\n⭕ ${mentionList(t.yes, mentionLimit)}`;
      if (t.maybe.length) value += `\n🔺 ${mentionList(t.maybe, mentionLimit)}`;
    }
    return { name: `${candidateLabel(c)}　⭕ ${t.yes.length}　🔺 ${t.maybe.length}${ended}${star}`, value };
  });

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
        : `回答 ${voters}人 ・「回答する」から、あなたの他の予定と照らし合わせて選べます`,
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

/**
 * 本人にだけ見える回答パネル。候補ごとに、本人の他の予定との重なりを並べ、
 * ⭕・🔺 のセレクトメニュー（複数選択）で回答してもらう。
 */
export function buildVotePanel(opts: {
  poll: PollRow;
  candidates: CandidateRow[];
  myVotes: Map<number, VoteValue>;
  conflicts: Map<number, Busy[]>;
  guildNames: Map<string, string>;
  timezone: string;
  now: number;
}) {
  const { poll, candidates, myVotes, conflicts, guildNames, timezone, now } = opts;
  const open = candidates.filter((c) => c.start_at > now);

  const lines: string[] = [];
  for (const c of candidates) {
    const my = myVotes.get(c.id);
    const mark = my ? VOTE_MARK[my] : "❌";
    const ended = c.start_at <= now ? "（終了）" : "";
    lines.push(`${candidateLabel(c)} ${candidateRange(c, poll)}　あなた: ${mark}${ended}`);
    for (const b of conflicts.get(c.id) ?? []) lines.push(`　└ ⚠️ ${formatBusyLine(b, guildNames)}`);
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
          ? `⚠️ ${conflictCount} 件の候補が、この bot で管理しているあなたの他の予定と重なっています`
          : "この bot で管理しているあなたの他の予定とは重なっていません",
    },
  };

  const select = (value: VoteValue, placeholder: string) => {
    const options: APISelectMenuOption[] = open.map((c) => {
      const busy = conflicts.get(c.id) ?? [];
      return {
        label: `${candidateLabel(c)} ${formatLocalShort(c.start_at, timezone)}`,
        value: String(c.id),
        description: busy.length > 0 ? formatBusyShort(busy, guildNames) : undefined,
        default: myVotes.get(c.id) === value,
      };
    });
    return {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: `poll:${value}:${poll.id}`,
          placeholder,
          min_values: 0,
          max_values: options.length,
          options,
        },
      ],
    } as APIActionRowComponent<APIComponentInMessageActionRow>;
  };

  return {
    content:
      open.length > 0
        ? "行ける日を ⭕、たぶん行ける日を 🔺 のメニューで選んでください（複数可。選ばなかった日は ❌）。\n" +
          "**日付を選んだら、メニューを閉じる（スマホは「選択」を押す）と回答が確定します。**確定すると下の「あなた:」に反映されます。"
        : "回答を受け付けている候補日はありません。",
    embeds: [embed],
    components:
      open.length > 0 ? [select("yes", "⭕ 行ける日を選んで確定（複数可）"), select("maybe", "🔺 たぶん行ける日を選んで確定（複数可）")] : [],
    allowed_mentions: { parse: [] },
  };
}

/** 「詳細」: 候補ごとの全員の回答。運営者には確定・中止の操作を出す */
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
      `**${candidateLabel(c)} ${candidateRange(c, poll)}**\n` +
      `⭕ (${t.yes.length}) ${t.yes.map(mention).join(" ") || "—"}\n` +
      `🔺 (${t.maybe.length}) ${t.maybe.map(mention).join(" ") || "—"}\n\n`;
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
            options: future.map((c) => {
              const t = tally.get(c.id)!;
              return {
                label: `${candidateLabel(c)} ${formatLocalShort(c.start_at, timezone)}　⭕${t.yes.length} 🔺${t.maybe.length}`,
                value: String(c.id),
              };
            }),
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
