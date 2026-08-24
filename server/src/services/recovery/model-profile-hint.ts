export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

export type RecoveryModelProfileWorkClass = "status_only" | "normal_model";

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

const RECOVERY_MODEL_PROFILE_HINT_KEYS = [
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
] as const;

type RecoveryModelProfileHintKey = (typeof RECOVERY_MODEL_PROFILE_HINT_KEYS)[number];
type WithoutRecoveryModelProfileHints<T> = Omit<T, RecoveryModelProfileHintKey>;

export function scrubRecoveryModelProfileHints<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryModelProfileHints<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_MODEL_PROFILE_HINT_KEYS) {
    delete output[key];
  }
  return output as WithoutRecoveryModelProfileHints<T>;
}

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryModelProfileHints<T>;
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
  modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
};
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: RecoveryModelProfileWorkClass,
):
  | WithoutRecoveryModelProfileHints<T>
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  }) {
  if (workClass === "normal_model") {
    return scrubRecoveryModelProfileHints(input);
  }

  return {
    ...scrubRecoveryModelProfileHints(input),
    ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

export function recoveryAssigneeAdapterOverrides(_workClass: Extract<RecoveryModelProfileWorkClass, "status_only">) {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}

export const ESCALATION_RECOVERY_MODEL_PROFILE_KEY = "escalate" as const;

/**
 * After >= 2 failed GENUINE re-attempts, stamp `modelProfile: "escalate"` onto a recovery wake so it
 * routes to the strong model. Two invariants this helper exists to enforce (both were live defects the
 * design review caught):
 *   1. Apply it to the OUTPUT of `withRecoveryModelProfileHint(..., "normal_model")` (i.e. AFTER the
 *      scrub). The scrub deletes any `modelProfile`, so stamping before it would silently no-op.
 *      Composing as a function call (not a spread) makes that ordering structural — it can't be
 *      accidentally reordered.
 *   2. Only ever onto the per-wake payload/contextSnapshot — never the issue's persistent override
 *      column — so it survives to dispatch, self-clears on the next wake, and can't disable a
 *      `status_only` recovery guard.
 * `attemptCount` < 2 (or undefined) returns `base` untouched (no `modelProfile` added).
 */
export function withRecoveryEscalationHint<T extends Record<string, unknown>>(
  base: T,
  attemptCount: number | undefined,
): T | (T & { modelProfile: typeof ESCALATION_RECOVERY_MODEL_PROFILE_KEY }) {
  if ((attemptCount ?? 0) >= 2) {
    return { ...base, modelProfile: ESCALATION_RECOVERY_MODEL_PROFILE_KEY };
  }
  return base;
}
