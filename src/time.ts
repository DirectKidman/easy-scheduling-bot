// 日時は UTC の UNIX 秒で扱う。サーバーのタイムゾーンは入力の解釈にだけ使う。

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** UTC ミリ秒を、指定タイムゾーンでの年月日時分に分解する */
export function toLocalParts(utcMs: number, tz: string): LocalParts & { second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function offsetMs(utcMs: number, tz: string): number {
  const p = toLocalParts(utcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/** タイムゾーン上の壁時計の時刻を UTC ミリ秒に変換する。存在しない時刻（夏時間の切り替え）は null。 */
export function zonedToUtcMs(local: LocalParts, tz: string): number | null {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let t = asUtc - offsetMs(asUtc, tz);
  t = asUtc - offsetMs(t, tz);
  const back = toLocalParts(t, tz);
  if (
    back.year !== local.year ||
    back.month !== local.month ||
    back.day !== local.day ||
    back.hour !== local.hour ||
    back.minute !== local.minute
  ) {
    return null;
  }
  return t;
}

export type ParseResult = { ok: true; unix: number } | { ok: false; reason: string };

const FORMAT_HINT = "「2026-10-11 19:00」「10/11 19:00」「10月11日 19時」のように入力してください。";

/**
 * 利用者が入力した日時をサーバーのタイムゾーンで解釈し、UTC の UNIX 秒を返す。
 * 年を省略した場合は、今日以降で最も近い日付にする。
 */
export function parseEventDateTime(input: string, tz: string, nowMs: number): ParseResult {
  let s = input.normalize("NFKC").trim();
  s = s
    .replace(/年|月/g, "/")
    .replace(/日/g, " ")
    .replace(/時半/g, ":30")
    .replace(/時/g, ":")
    .replace(/分/g, "")
    .replace(/\([^)]*\)/g, " ") // 曜日表記 "(土)" を無視
    .replace(/T/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.endsWith(":")) s += "00";

  const m = /^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2}) (\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return { ok: false, reason: `日時の形式が読み取れませんでした。${FORMAT_HINT}` };

  const [, y, mo, d, h, mi] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { ok: false, reason: `日時の値が範囲外です。${FORMAT_HINT}` };
  }

  const today = toLocalParts(nowMs, tz);
  let year = y ? Number(y) : today.year;
  if (!y) {
    // 年の省略時: 今日より前の日付なら来年とみなす
    const candidate = month * 100 + day;
    const todayKey = today.month * 100 + today.day;
    if (candidate < todayKey) year += 1;
  }

  // 日付として存在するか（2/30 など）
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { ok: false, reason: "存在しない日付です。" };
  }

  const utcMs = zonedToUtcMs({ year, month, day, hour, minute }, tz);
  if (utcMs === null) {
    return { ok: false, reason: "その時刻はサーバーのタイムゾーンでは存在しません（夏時間の切り替え）。" };
  }
  return { ok: true, unix: Math.floor(utcMs / 1000) };
}
