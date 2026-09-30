import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テスト用の Ed25519 鍵ペア。公開鍵は Worker に、秘密鍵はテストの署名に使う。
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).toString("hex");

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            DISCORD_PUBLIC_KEY: publicKeyHex,
            DISCORD_BOT_TOKEN: "test-bot-token",
            DISCORD_APPLICATION_ID: "100000000000000001",
            TEST_PRIVATE_KEY: privateKeyHex,
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      // discord-api-types の ESM ラッパーが Workers 用テストランナーで値を解決できないため、事前バンドルする
      deps: { optimizer: { ssr: { enabled: true, include: ["discord-api-types/v10"] } } },
    },
  };
});
