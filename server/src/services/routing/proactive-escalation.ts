import { ESCALATION_RECOVERY_MODEL_PROFILE_KEY } from "../recovery/model-profile-hint.js";

/**
 * Proactive (pre-failure) routing to the strong-model escalation lane.
 *
 * The recovery path already escalates a wake to the strong model AFTER >= 2 failed
 * re-attempts (`withRecoveryEscalationHint`). This module is the deliberate,
 * BEFORE-failure counterpart: it lets designated high-value agents / work route to
 * the strong model on a normal wake, so the local dense Qwen3.8-27B escalation lane
 * is leveraged for high-value work instead of only firing on failure.
 *
 * Safety model (why this can't crater the fleet): the "escalate" profile routes to
 * the :8010 capped proxy, which holds 3.8-27B to 1 request in-flight and transparently
 * downgrades to the always-resident MoE coder when saturated. So even a burst of
 * proactively-escalated wakes serialises / downgrades — bounded, never a stampede.
 *
 * The two CONTEXT-safety guards (only stamp when the wake has no profile yet, and
 * there is no sticky issue-level override) live at the call site in heartbeat
 * `executeRun`, mirroring how the recovery escalate stamps only the per-wake context
 * and never the persistent `assigneeAdapterOverrides` column.
 */

/**
 * Companies whose non-planning work should proactively escalate by default.
 * Empty by default — add a company id (e.g. Twenty Four
 * `54f418d2-d1ef-400f-9f09-684246293de1`) for a blanket, per-agent-config-free
 * rollout. Prefer the per-agent `runtimeConfig.proactiveModelProfile` flag for
 * finer-grained control.
 */
export const HIGH_VALUE_COMPANY_IDS: ReadonlySet<string> = new Set<string>([
  "54f418d2-d1ef-400f-9f09-684246293de1", // Twenty Four — blanket proactive escalation of non-planning work
]);

/**
 * When true, any `critical`-priority non-planning issue proactively escalates,
 * regardless of per-agent config — "high-value WORK gets the strong model." Bounded
 * (critical issues are rare) and safe (the :8010 cap + downgrade valve). Flip to
 * false to make proactive escalation strictly opt-in via the per-agent flag /
 * company allowlist.
 */
export const ESCALATE_CRITICAL_PRIORITY = true;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** True iff the agent's runtimeConfig opts this agent into proactive escalation. */
function agentOptsIntoProactiveEscalation(runtimeConfig: unknown): boolean {
  return asRecord(runtimeConfig).proactiveModelProfile === ESCALATION_RECOVERY_MODEL_PROFILE_KEY;
}

/**
 * Decide whether a NORMAL (non-recovery, pre-failure) issue wake should route to the
 * strong-model "escalate" lane. Pure and side-effect-free so it is unit-testable in
 * isolation from the heartbeat.
 *
 * Guard baked in: PLANNING wakes NEVER escalate. The dense strong model hallucinates
 * on orchestration/planning (2026-08-16 adversarial bench-off — fabricates tools,
 * files, approvals); planning stays on the fleet-brain orchestrator. Only
 * implementation / analysis work is eligible.
 */
export function shouldProactivelyEscalate(input: {
  agentRuntimeConfig: unknown;
  companyId: string | null | undefined;
  issuePriority?: string | null;
  issueWorkMode?: string | null;
  hasIssueWork?: boolean;
}): boolean {
  if (input.issueWorkMode === "planning") return false;
  // Only real issue work escalates. Idle heartbeat "seek work" wakes carry no issue -- escalating
  // them would load the slow dense 27B for trivial "what should I do?" seek calls and thrash it
  // in/out against the resident coder every idle cycle. The strong lane is for WORK, not seeks.
  if (!input.hasIssueWork) return false;
  if (agentOptsIntoProactiveEscalation(input.agentRuntimeConfig)) return true;
  if (input.companyId && HIGH_VALUE_COMPANY_IDS.has(input.companyId)) return true;
  if (ESCALATE_CRITICAL_PRIORITY && input.issuePriority === "critical") return true;
  return false;
}
