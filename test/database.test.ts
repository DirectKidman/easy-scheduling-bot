import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DAILY_CRON } from "../src/jobs/scheduled";
import { GUILD_ID, nowSec, resetDb, runCron, seedEvent, seedServer } from "./helpers";

const count = async (table: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");

beforeEach(resetDb);

describe("D1 の外部キーと ON DELETE CASCADE", () => {
  it("イベントを消すと回答も消える", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() });
    await env.DB.prepare("INSERT INTO responses VALUES (?1, 'u1', 'going', 1)").bind(id).run();
    await env.DB.prepare("DELETE FROM events WHERE id = ?1").bind(id).run();
    expect(await count("responses")).toBe(0);
  });

  it("サーバーを消すとイベントと回答も消える", async () => {
    await seedServer();
    const id = await seedEvent({ startAt: nowSec() });
    await env.DB.prepare("INSERT INTO responses VALUES (?1, 'u1', 'going', 1)").bind(id).run();
    await env.DB.prepare("DELETE FROM servers WHERE guild_id = ?1").bind(GUILD_ID).run();
    expect(await count("events")).toBe(0);
    expect(await count("responses")).toBe(0);
  });

  it("存在しないイベントへの回答は外部キー制約で拒否される", async () => {
    await expect(env.DB.prepare("INSERT INTO responses VALUES (999, 'u1', 'going', 1)").run()).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("時間経過の削除ジョブ", () => {
  it("開始から保持期間（30日）を過ぎたイベントと回答だけを消す。何度実行しても同じ結果", async () => {
    await seedServer();
    const now = nowSec();
    const day = 86400;
    const old = await seedEvent({ startAt: now - 31 * day });
    const recent = await seedEvent({ startAt: now - 29 * day });
    const future = await seedEvent({ startAt: now + day });
    const insert = env.DB.prepare("INSERT INTO responses VALUES (?1, 'u1', 'going', 1)");
    await env.DB.batch([insert.bind(old), insert.bind(recent), insert.bind(future)]);

    await runCron(DAILY_CRON, now * 1000);
    await runCron(DAILY_CRON, now * 1000);

    const ids = (await env.DB.prepare("SELECT id FROM events ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    expect(ids).toEqual([recent, future]);
    expect(await count("responses")).toBe(2);
  });
});
