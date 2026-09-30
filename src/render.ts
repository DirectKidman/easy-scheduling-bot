import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
} from "discord-api-types/v10";
import type { EventRow, ResponseRow, RsvpStatus } from "./db/queries";

export const STATUS_META: Record<RsvpStatus, { emoji: string; label: string }> = {
  going: { emoji: "✅", label: "参加" },
  maybe: { emoji: "🤔", label: "未定" },
  declined: { emoji: "❌", label: "不参加" },
};
export const STATUSES: RsvpStatus[] = ["going", "maybe", "declined"];

/** 告知メッセージの名簿に表示する最大人数（超えた分は「他n人」） */
export const ROSTER_LIMIT = 20;

const COLOR_SCHEDULED = 0x5865f2;
const COLOR_CANCELLED = 0x80848e;

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>[\]()#-])/g, "\\$1");
}

export function mention(userId: string): string {
  return `<@${userId}>`;
}

/** 「<開始> 〜 <終了>（あと何日）」。終了は日付をまたぐ長さなら日付付きで出す */
export function formatTimeRange(startAt: number, durationMinutes: number): string {
  const end = startAt + durationMinutes * 60;
  const endStyle = durationMinutes >= 24 * 60 ? "f" : "t";
  return `<t:${startAt}:F> 〜 <t:${end}:${endStyle}>（<t:${startAt}:R>）`;
}

/** 告知メッセージ本文（日時・場所・主催・説明）。作成時にだけ作り、以後はメッセージ側を正とする。 */
export function buildHeader(opts: {
  startAt: number;
  durationMinutes: number;
  location?: string;
  hostId: string;
  description?: string;
}): string {
  const lines = [`日時　${formatTimeRange(opts.startAt, opts.durationMinutes)}`];
  if (opts.location) lines.push(`場所　${opts.location}`);
  lines.push(`主催　${mention(opts.hostId)}`);
  let text = lines.join("\n");
  if (opts.description) text += `\n\n${opts.description}`;
  return text;
}

/** メッセージの埋め込みが読めない場合の代替ヘッダー */
export function fallbackHeader(event: Pick<EventRow, "start_at" | "duration_minutes">): string {
  return `日時　${formatTimeRange(event.start_at, event.duration_minutes)}`;
}

export function groupResponses(responses: ResponseRow[]): Record<RsvpStatus, string[]> {
  const groups: Record<RsvpStatus, string[]> = { going: [], maybe: [], declined: [] };
  for (const r of responses) groups[r.status].push(r.user_id);
  return groups;
}

function rosterField(status: RsvpStatus, userIds: string[]): APIEmbedField {
  const { emoji, label } = STATUS_META[status];
  const shown = userIds.slice(0, ROSTER_LIMIT).map(mention).join(" ");
  const rest = userIds.length - ROSTER_LIMIT;
  const value = shown ? (rest > 0 ? `${shown} 他${rest}人` : shown) : "—";
  return { name: `${emoji} ${label} (${userIds.length})`, value };
}

export function buildAnnouncementEmbed(event: EventRow, header: string, responses: ResponseRow[]): APIEmbed {
  const groups = groupResponses(responses);
  const cancelled = event.state === "cancelled";
  return {
    title: `${cancelled ? "【中止】" : ""}📅 ${event.title}`,
    description: header,
    color: cancelled ? COLOR_CANCELLED : COLOR_SCHEDULED,
    fields: STATUSES.map((s) => rosterField(s, groups[s])),
  };
}

export function buildAnnouncementComponents(
  event: EventRow,
): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  if (event.state !== "scheduled") return [];
  const button = (
    status: RsvpStatus,
    style: ButtonStyle.Success | ButtonStyle.Secondary | ButtonStyle.Danger,
  ): APIButtonComponentWithCustomId => ({
    type: ComponentType.Button,
    style,
    custom_id: `rsvp:${event.id}:${status}`,
    label: STATUS_META[status].label,
    emoji: { name: STATUS_META[status].emoji },
  });
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        button("going", ButtonStyle.Success),
        button("maybe", ButtonStyle.Secondary),
        button("declined", ButtonStyle.Danger),
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          custom_id: `detail:${event.id}`,
          label: "詳細",
          emoji: { name: "⋯" },
        },
      ],
    },
  ];
}

/** 告知メッセージ全体（投稿・編集・ボタン応答で共通） */
export function buildAnnouncement(event: EventRow, header: string, responses: ResponseRow[]) {
  return {
    embeds: [buildAnnouncementEmbed(event, header, responses)],
    components: buildAnnouncementComponents(event),
    // 埋め込み内のメンションはもともと通知されないが、念のため明示する
    allowed_mentions: { parse: [] },
  };
}

/** 「詳細」ボタン用: 全員の一覧（埋め込みの説明欄 4096 文字に収める） */
export function buildRosterDetail(event: EventRow, responses: ResponseRow[]): string {
  const groups = groupResponses(responses);
  const LIMIT = 4000;
  let out = "";
  for (const s of STATUSES) {
    const { emoji, label } = STATUS_META[s];
    const ids = groups[s];
    out += `${out ? "\n\n" : ""}**${emoji} ${label} (${ids.length})**\n`;
    if (ids.length === 0) {
      out += "—";
      continue;
    }
    let shown = 0;
    for (const id of ids) {
      const piece = (shown ? " " : "") + mention(id);
      if (out.length + piece.length > LIMIT - 20) break;
      out += piece;
      shown++;
    }
    if (shown < ids.length) out += ` 他${ids.length - shown}人`;
  }
  return out;
}

export function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
