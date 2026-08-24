/** Unit tests for workspaceSafety service */

import { workspaceSafety } from './workspace-safety.js';

// ---- helpers ----------------------------------------------------------- */

/** Assert a condition or record a failure message. */
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ---- test envs --------------------------------------------------------- */

/** Environment with known credential-like keys and values. */
const credEnv: Record<string, string> = {
  NORMAL_VAR: "value",
  API_KEY_OPENAI: "sk-abc123",
  DATABASE_URL: "postgres://localhost:5432/db",
  AWS_ACCESS_KEY_ID: "AKIA...",
  NORMAL_SECRET: "test",
  PASSWORD_DB: "secret123",
  STRIPE_API_KEY: "sk_live_abc1234567890123456",
  CUSTOM_TOKEN: "bearer_token_xxxxxxxxxxxxxxxxxxxxxx",
};

/** Clean environment with no suspicious keys or values. */
const cleanEnv: Record<string, string> = {
  NORMAL_VAR: "value",
  ANOTHER_VAR: "another_value",
};

// ---- checkGuards tests ------------------------------------------------- */

function testCheckGuards(): void {
  const result = workspaceSafety.checkGuards(credEnv);

  assert(!result.safe, "credEnv should not be marked safe");
  assert(result.guardsChecked === 7, `Expected 7 guard rules checked, got ${result.guardsChecked}`);
  assert(result.issues.length > 0, "Should have found issues in credEnv");

  // Check that known suspicious keys were caught
  const keysCaught = result.issues.map((i) => i.key);
  assert(keysCaught.includes("API_KEY_OPENAI"), "Should catch API_KEY_OPENAI");
  assert(keysCaught.includes("DATABASE_URL"), "Should catch DATABASE_URL");
  assert(keysCaught.includes("AWS_ACCESS_KEY_ID"), "Should catch AWS_ACCESS_KEY_ID");

  // Clean env should be safe
  const cleanResult = workspaceSafety.checkGuards(cleanEnv);
  assert(cleanResult.safe, "cleanEnv should be safe");
  assert(cleanResult.issues.length === 0, "cleanEnv should have no issues");

  console.log("checkGuards: OK");
}

// ---- detectLeaks tests ------------------------------------------------- */

function testDetectLeaks(): void {
  const result = workspaceSafety.detectLeaks(credEnv);

  assert(!result.safe, "credEnv should not be safe for leaks");
  assert(result.scanned === true, "scanned should be true");
  assert(result.rulesApplied === 2, `Expected 2 leak rules applied, got ${result.rulesApplied}`);
  assert(result.leakages.length > 0, "Should have found leakages in credEnv");

  // Check that known suspicious keys were caught
  const leakedKeys = result.leakages.map((l) => l.key);
  assert(leakedKeys.includes("API_KEY_OPENAI"), "Should catch API_KEY_OPENAI in key check");

  // Clean env should be safe
  const cleanResult = workspaceSafety.detectLeaks(cleanEnv);
  assert(cleanResult.safe, "cleanEnv should be safe for leaks");
  assert(cleanResult.leakages.length === 0, "cleanEnv should have no leakages");

  console.log("detectLeaks: OK");
}

// ---- run --------------------------------------------------------------- */

console.log("workspaceSafety tests...");
try {
  testCheckGuards();
  testDetectLeaks();
  console.log("All tests passed.");
} catch (err) {
  console.error("Test FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
