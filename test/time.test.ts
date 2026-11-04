import { describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatRange,
  isValidTimeZone,
  parseCandidates,
  parseDuration,
  parseEventDateTime,
} from "../src/time";

const TOKYO = "Asia/Tokyo";
// 2026-09-30 12:00 JST
const NOW = Date.UTC(2026, 8, 30, 3, 0);

function unix(iso: string): number {
  return Date.parse(iso) / 1000;
}

describe("parseEventDateTime", () => {
  it.each([
    ["2026-10-11 19:00", "2026-10-11T10:00:00Z"],
    ["2026/10/11 19:00", "2026-10-11T10:00:00Z"],
    ["2026-10-11T19:00", "2026-10-11T10:00:00Z"],
    ["10/11 19:00", "2026-10-11T10:00:00Z"],
    ["１０／１１　１９：００", "2026-10-11T10:00:00Z"],
    ["10月11日 19時", "2026-10-11T10:00:00Z"],
    ["10月11日(土) 19時半", "2026-10-11T10:30:00Z"],
    ["2026年10月11日 9:05", "2026-10-11T00:05:00Z"],
  ])("%s をサーバーのタイムゾーンで解釈する", (input, expected) => {
    expect(parseEventDateTime(input, TOKYO, NOW)).toEqual({ ok: true, unix: unix(expected) });
  });

  it("年を省略して今日より前の日付なら来年にする", () => {
    expect(parseEventDateTime("1/5 10:00", TOKYO, NOW)).toEqual({ ok: true, unix: unix("2027-01-05T01:00:00Z") });
  });

  it("年を省略して今日の日付なら今年のまま（時刻が過ぎていれば呼び出し側で弾く）", () => {
    expect(parseEventDateTime("9/30 20:00", TOKYO, NOW)).toEqual({ ok: true, unix: unix("2026-09-30T11:00:00Z") });
  });

  it("他のタイムゾーンでも UTC に変換する（夏時間を含む）", () => {
    expect(parseEventDateTime("2026-07-01 12:00", "America/New_York", NOW)).toEqual({
      ok: true,
      unix: unix("2026-07-01T16:00:00Z"),
    });
    expect(parseEventDateTime("2026-12-01 12:00", "America/New_York", NOW)).toEqual({
      ok: true,
      unix: unix("2026-12-01T17:00:00Z"),
    });
  });

  it("夏時間の切り替えで存在しない時刻は拒否する", () => {
    const r = parseEventDateTime("2027-03-14 02:30", "America/New_York", NOW);
    expect(r.ok).toBe(false);
  });

  it.each(["明日", "2026-10-11", "2026-13-01 10:00", "2026-02-30 10:00", "10/11 25:00"])("%s は拒否する", (input) => {
    expect(parseEventDateTime(input, TOKYO, NOW).ok).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("IANA 形式だけを受け付ける", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Tokyo/Japan")).toBe(false);
  });
});

describe("parseDuration", () => {
  it.each([
    ["", 120],
    ["2h", 120],
    ["90m", 90],
    ["90", 90],
    ["1h30m", 90],
    ["1.5h", 90],
    ["2時間", 120],
    ["1時間30分", 90],
    ["４５分", 45],
  ])("%s → %i 分", (input, minutes) => {
    expect(parseDuration(input)).toEqual({ ok: true, minutes });
  });

  it.each(["2", "abc", "0m", "8日", "200h"])("%s は拒否する", (input) => {
    expect(parseDuration(input).ok).toBe(false);
  });
});

describe("表示用の整形（タイムスタンプ記法を使わない）", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;

  it("サーバーのタイムゾーンで「月/日(曜) 時:分」にする", () => {
    expect(formatDateTime(at("2026-10-11T10:00:00Z"), TOKYO)).toBe("10/11(日) 19:00");
  });

  it("今と年が違えば年を付ける", () => {
    const now = at("2026-12-20T00:00:00Z");
    expect(formatDateTime(at("2027-01-05T10:00:00Z"), TOKYO, now)).toBe("2027/1/5(火) 19:00");
    expect(formatDateTime(at("2026-12-25T10:00:00Z"), TOKYO, now)).toBe("12/25(金) 19:00");
  });

  it("範囲は同じ日なら終了を時刻だけ、日付をまたげば日付付きにする", () => {
    expect(formatRange(at("2026-11-12T10:00:00Z"), 120, TOKYO)).toBe("11/12(木) 19:00〜21:00");
    expect(formatRange(at("2026-11-12T13:00:00Z"), 240, TOKYO)).toBe("11/12(木) 22:00〜11/13(金) 02:00");
  });

  it("日本時間以外ではタイムゾーンを添える", () => {
    expect(formatRange(at("2026-11-12T00:00:00Z"), 60, "America/New_York")).toBe(
      "11/11(水) 19:00〜20:00（America/New_York）",
    );
  });
});

describe("parseCandidates", () => {
  it("空行を無視し、重複を除いて日時順に並べる", () => {
    const r = parseCandidates("10/12 14:00\n\n10/11 19:00\n10/12 14:00", TOKYO, NOW);
    expect(r).toEqual({ ok: true, unix: [unix("2026-10-11T10:00:00Z"), unix("2026-10-12T05:00:00Z")] });
  });

  it("過去の候補は行番号付きで拒否する", () => {
    const r = parseCandidates("10/11 19:00\n2026-09-01 10:00", TOKYO, NOW);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("2 行目") });
  });
});
