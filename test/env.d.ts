import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_PRIVATE_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
