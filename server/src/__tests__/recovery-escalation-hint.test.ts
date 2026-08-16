import { describe, expect, it } from "vitest";
import { MODEL_PROFILE_KEYS } from "@paperclipai/shared";
import {
  ESCALATION_RECOVERY_MODEL_PROFILE_KEY,
  withRecoveryEscalationHint,
  withRecoveryModelProfileHint,
} from "../services/recovery/model-profile-hint.js";

// Regression guard for the concurrency-gated auto-escalation trigger (Gap 2). The recovery service
// stamps modelProfile:"escalate" onto a genuine re-attempt only after >= 2 consecutive failures, via
// withRecoveryEscalationHint applied to the OUTPUT of withRecoveryModelProfileHint(..., "normal_model").
// These tests compose the two real functions exactly as enqueueStrandedIssueRecovery does, so they
// fail if either invariant the design review caught ever regresses.
describe("withRecoveryEscalationHint (auto-escalation trigger)", () => {
  it("stamps modelProfile:escalate at attemptCount >= 2", () => {
    expect(withRecoveryEscalationHint({ issueId: "i1" }, 2)).toEqual({
      issueId: "i1",
      modelProfile: "escalate",
    });
    expect(withRecoveryEscalationHint({ issueId: "i1" }, 7)).toMatchObject({
      modelProfile: "escalate",
    });
  });

  it("does NOT escalate below 2 attempts (undefined, 0, 1)", () => {
    for (const attemptCount of [undefined, 0, 1]) {
      const out = withRecoveryEscalationHint({ issueId: "i1" }, attemptCount);
      expect(out).not.toHaveProperty("modelProfile");
      expect(out).toEqual({ issueId: "i1" });
    }
  });

  // THE core regression guard: escalate must be applied AFTER the normal_model scrub so it survives.
  // If a refactor ever stamps escalate BEFORE withRecoveryModelProfileHint(..., "normal_model"), the
  // scrub deletes modelProfile and the wake silently falls back to the default model -- the exact
  // HIGH-severity defect the adversarial design pass caught. Composed here as the source composes them.
  it("survives the normal_model scrub when composed the way the service composes it", () => {
    const payload = withRecoveryEscalationHint(
      withRecoveryModelProfileHint({ issueId: "i1", retryOfRunId: "run-9" }, "normal_model"),
      2,
    );
    expect(payload).toMatchObject({
      issueId: "i1",
      retryOfRunId: "run-9",
      modelProfile: "escalate",
    });
  });

  // A non-escalated normal_model wake carries neither modelProfile nor any status_only guard field.
  it("normal_model + no escalation leaves neither modelProfile nor status_only guard fields", () => {
    const payload = withRecoveryEscalationHint(
      withRecoveryModelProfileHint({ issueId: "i1" }, "normal_model"),
      1,
    );
    expect(payload).not.toHaveProperty("modelProfile");
    expect(payload).not.toHaveProperty("recoveryIntent");
    expect(payload).not.toHaveProperty("allowDeliverableWork");
    expect(payload).not.toHaveProperty("resumeRequiresNormalModel");
  });

  // Escalation is NOT the cheap/status_only path: it must stamp only modelProfile:"escalate" and must
  // never smuggle in the status_only guard context (which would forbid deliverable work on a wake that
  // is meant to do real work with the strong model).
  it("escalation stamps only modelProfile:escalate, never the status_only guard context", () => {
    const payload = withRecoveryEscalationHint(
      withRecoveryModelProfileHint({ issueId: "i1" }, "normal_model"),
      3,
    );
    expect(payload).toMatchObject({ modelProfile: "escalate" });
    expect(payload).not.toHaveProperty("allowDeliverableWork");
    expect(payload).not.toHaveProperty("allowDocumentUpdates");
    expect(payload).not.toHaveProperty("resumeRequiresNormalModel");
    expect(payload).not.toHaveProperty("recoveryIntent");
  });

  // Cross-module guard: the key the recovery module stamps must be a key the dispatch whitelist
  // (MODEL_PROFILE_KEYS, in @paperclipai/shared) actually recognizes. If shared renamed/removed
  // "escalate", the stamped hint would be silently ignored at dispatch and escalation would no-op.
  it("stamps a key that the shared MODEL_PROFILE_KEYS whitelist recognizes", () => {
    expect(MODEL_PROFILE_KEYS).toContain(ESCALATION_RECOVERY_MODEL_PROFILE_KEY);
    const stamped = withRecoveryEscalationHint({}, 2) as { modelProfile?: string };
    expect(MODEL_PROFILE_KEYS).toContain(stamped.modelProfile);
  });
});
