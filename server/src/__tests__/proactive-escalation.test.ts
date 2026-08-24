import { describe, expect, it } from "vitest";
import { MODEL_PROFILE_KEYS } from "@paperclipai/shared";
import { ESCALATION_RECOVERY_MODEL_PROFILE_KEY } from "../services/recovery/model-profile-hint.js";
import { shouldProactivelyEscalate } from "../services/routing/proactive-escalation.js";

// Regression guard for PROACTIVE (pre-failure) high-value routing to the strong-model lane.
// The predicate must (a) opt in designated agents, (b) escalate critical work by default,
// and (c) NEVER escalate a planning wake -- the dense strong model hallucinates on
// orchestration/planning (2026-08-16 bench-off), so planning must stay on the fleet brain.
const OPTED_IN = { proactiveModelProfile: ESCALATION_RECOVERY_MODEL_PROFILE_KEY };

describe("shouldProactivelyEscalate (proactive high-value routing)", () => {
  it("escalates an opted-in agent on non-planning work", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: OPTED_IN,
        companyId: "c1",
        issuePriority: "medium",
        issueWorkMode: "execution",
        hasIssueWork: true,
      }),
    ).toBe(true);
  });

  // THE core guard: an opted-in agent on a PLANNING wake must NOT escalate.
  it("never escalates a planning wake, even for an opted-in agent", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: OPTED_IN,
        companyId: "c1",
        issuePriority: "critical",
        issueWorkMode: "planning",
        hasIssueWork: true,
      }),
    ).toBe(false);
  });

  // The idle-seek guard: an opted-in agent whose wake carries NO issue (a heartbeat "seek work"
  // cycle) must NOT escalate -- the strong lane is for real work, not idle "what should I do?"
  // calls that would thrash the dense 27B in/out against the coder every cycle.
  it("never escalates an idle no-issue seek wake, even for an opted-in agent", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: OPTED_IN,
        companyId: "c1",
        issuePriority: undefined,
        issueWorkMode: undefined,
        hasIssueWork: false,
      }),
    ).toBe(false);
  });

  it("does not escalate a non-opted-in agent on ordinary work", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: { modelProfiles: {} },
        companyId: "c1",
        issuePriority: "medium",
        issueWorkMode: "execution",
        hasIssueWork: true,
      }),
    ).toBe(false);
  });

  // DISABLED 2026-08-17: critical-priority no longer auto-escalates. Escalating a critical
  // issue's WHOLE run to the ~36 tok/s 27B times out (1800s cap); critical work stays on the
  // fast model and delegates hard subtasks to the 27B. ESCALATE_CRITICAL_PRIORITY = false.
  it("does NOT auto-escalate critical-priority work (whole-run escalation disabled)", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: {},
        companyId: "c1",
        issuePriority: "critical",
        issueWorkMode: "execution",
        hasIssueWork: true,
      }),
    ).toBe(false);
  });

  it("does not escalate critical-priority PLANNING work (planning guard beats the critical gate)", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: {},
        companyId: "c1",
        issuePriority: "critical",
        issueWorkMode: "planning",
        hasIssueWork: true,
      }),
    ).toBe(false);
  });

  // runtimeConfig is jsonb -- may arrive as an object or a JSON string. Both must work, and
  // malformed input must fail closed (no escalation), never throw.
  it("reads the opt-in flag from a JSON-string runtimeConfig", () => {
    expect(
      shouldProactivelyEscalate({
        agentRuntimeConfig: JSON.stringify(OPTED_IN),
        companyId: "c1",
        issuePriority: "low",
        issueWorkMode: null,
        hasIssueWork: true,
      }),
    ).toBe(true);
  });

  it("fails closed on malformed / empty runtimeConfig without throwing", () => {
    for (const cfg of [null, undefined, "not json", 42, "", {}]) {
      expect(
        shouldProactivelyEscalate({
          agentRuntimeConfig: cfg,
          companyId: null,
          issuePriority: "low",
          issueWorkMode: null,
          hasIssueWork: true,
        }),
      ).toBe(false);
    }
  });

  // Cross-module guard: the opt-in flag value must be a profile key dispatch recognizes,
  // otherwise a stamped "escalate" would be silently ignored downstream.
  it("uses an opt-in flag value that the shared MODEL_PROFILE_KEYS whitelist recognizes", () => {
    expect(MODEL_PROFILE_KEYS).toContain(ESCALATION_RECOVERY_MODEL_PROFILE_KEY);
  });
});
