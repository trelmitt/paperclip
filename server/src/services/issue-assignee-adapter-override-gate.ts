import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { getBuiltInAgentDefinition } from "./built-in-agents.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { findServerAdapter, listAdapterModels, listServerAdapters } from "../adapters/registry.js";
import { getDisabledAdapterTypes } from "./adapter-plugin-store.js";

/**
 * G (per-issue runner override): a per-issue `adapterType` reroutes the assignee's whole
 * runner, so it is validated at write time — "constrain to the agent's allowed adapters,
 * never escalate". Three layers:
 *   1. Instance floor (every agent): the type must be known + enabled on this instance
 *      (same rule as agent create/hire). You cannot force an adapter the instance curated out.
 *   2. Model/adapter coherence (Phase 1): the whole run keys off the override adapter, so the
 *      effective model must exist for it — else the run fails deep at launch, not at the write.
 *   3. Built-in allowlist: `allowedAdapterTypes` exists ONLY on built-in agent definitions; a
 *      built-in assignee's override must stay inside it. Regular agents carry no per-agent
 *      allowlist, so the instance floor is their constraint. Absent/blank adapterType (e.g. a
 *      model-only override) is a no-op here.
 *
 * Lives in the service layer (not the HTTP route) so EVERY caller is gated — the Express
 * routes AND the plugin-host / SDK path (services.issues.create/update), which reaches
 * issueService directly and would otherwise bypass validation. Throws HttpError on rejection.
 */
export async function assertIssueAssigneeAdapterOverrideAllowed(
  db: Db,
  companyId: string,
  input: { assigneeAdapterOverrides?: unknown; assigneeAgentId?: unknown },
  fallbackAssigneeAgentId: string | null,
): Promise<void> {
  const overrides = input.assigneeAdapterOverrides;
  const rawType = overrides && typeof overrides === "object" && !Array.isArray(overrides)
    ? (overrides as Record<string, unknown>).adapterType
    : undefined;
  if (typeof rawType !== "string" || !rawType.trim()) return;
  const adapterType = rawType.trim();

  // Layer 1 — known + enabled on this instance.
  if (!findServerAdapter(adapterType)) {
    throw unprocessable(`Unknown adapter type: ${adapterType}`);
  }
  const disabled = new Set(getDisabledAdapterTypes());
  if (disabled.has(adapterType)) {
    const available = listServerAdapters().map((a) => a.type).filter((t) => !disabled.has(t)).sort();
    throw unprocessable(
      `Adapter "${adapterType}" is not available on this instance. `
      + `Available adapters: ${available.length > 0 ? available.join(", ") : "(none configured)"}`,
    );
  }

  // Resolve the effective assignee once; both the model check (inherited model) and the
  // built-in allowlist need its configured adapter.
  const overrideRecord = overrides as Record<string, unknown>;
  const bodyAssignee = typeof input.assigneeAgentId === "string" && input.assigneeAgentId.trim()
    ? input.assigneeAgentId.trim()
    : undefined;
  const assigneeAgentId = bodyAssignee ?? fallbackAssigneeAgentId;
  const agentRow = assigneeAgentId
    ? await db
      .select({ metadata: agents.metadata, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null)
    : null;

  // Check 2 — model/adapter coherence. A modelProfile-only override resolves per-adapter at
  // run time (coherent by construction) and is skipped; otherwise the literal model — the
  // override's own, or the agent's inherited one — must exist for the target adapter. Adapters
  // that list no models (process/dynamic) soft-skip.
  const overrideAdapterConfig = overrideRecord.adapterConfig
    && typeof overrideRecord.adapterConfig === "object"
    && !Array.isArray(overrideRecord.adapterConfig)
    ? overrideRecord.adapterConfig as Record<string, unknown>
    : null;
  const overrideModel = typeof overrideAdapterConfig?.model === "string" ? overrideAdapterConfig.model.trim() : "";
  const hasModelProfile = typeof overrideRecord.modelProfile === "string" && overrideRecord.modelProfile.trim().length > 0;
  const agentAdapterConfig = agentRow?.adapterConfig
    && typeof agentRow.adapterConfig === "object"
    && !Array.isArray(agentRow.adapterConfig)
    ? agentRow.adapterConfig as Record<string, unknown>
    : null;
  const inheritedModel = typeof agentAdapterConfig?.model === "string" ? agentAdapterConfig.model.trim() : "";
  const effectiveModel = overrideModel || (hasModelProfile ? "" : inheritedModel);
  if (effectiveModel) {
    const models = await listAdapterModels(adapterType);
    if (models.length > 0 && !models.some((candidate) => candidate.id === effectiveModel)) {
      throw unprocessable(
        `Model "${effectiveModel}" is not available for adapter ${adapterType}. `
        + `Set assigneeAdapterOverrides.adapterConfig.model to one of: ${models.map((m) => m.id).join(", ")}`,
        {
          code: "issue_assignee_adapter_override_model_unknown",
          adapterType,
          model: effectiveModel,
          availableModelIds: models.map((candidate) => candidate.id),
        },
      );
    }
  }

  // Check 3 — built-in assignee allowlist.
  if (!agentRow) return;
  const marker = readBuiltInAgentMarker(agentRow.metadata);
  const definition = marker?.key ? getBuiltInAgentDefinition(marker.key) : null;
  if (definition?.allowedAdapterTypes && !definition.allowedAdapterTypes.includes(adapterType)) {
    throw forbidden(`Adapter "${adapterType}" is not permitted for built-in agent ${definition.key}`, {
      code: "issue_assignee_adapter_override_not_allowed",
      adapterType,
      allowedAdapterTypes: definition.allowedAdapterTypes,
      agentId: assigneeAgentId,
      builtInAgentKey: definition.key,
    });
  }
}
