/**
 * One-time CLI for the backlog-E historical backfill (see
 * services/issue-events-backfill.ts). Idempotent + resumable — safe to re-run.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @paperclipai/server backfill:issue-events
 *
 * Assumes migrations are already applied (issue_events exists). Reads the same
 * DATABASE_URL the server uses; refuses the embedded/PGlite dev fallback because a
 * backfill against an ephemeral store is meaningless.
 */
import { createDb } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import { backfillIssueEvents } from "../src/services/issue-events-backfill.js";

async function main() {
  const config = loadConfig();
  const url = config.databaseUrl;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.error(
      "[backfill] DATABASE_URL must be an external Postgres connection string; got:",
      url ?? "(unset)",
    );
    process.exit(1);
  }

  const db = createDb(url);
  console.log("[backfill] starting issue_events backfill…");
  const result = await backfillIssueEvents(db, { log: (msg) => console.log(`[backfill] ${msg}`) });
  console.log("[backfill] done:", JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error("[backfill] failed:", error);
  process.exit(1);
});
