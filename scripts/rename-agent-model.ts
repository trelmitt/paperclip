import { PaperclipApiClient } from "../cli/src/client/http.js";
import { getStoredBoardCredential } from "../cli/src/client/board-auth.js";

interface Agent {
  id: string;
  name: string;
  companyId: string;
  adapterConfig?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
}

interface Company {
  id: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

interface Match {
  path: string;
  set: (root: Record<string, unknown>, value: string) => void;
}

function findMatches(agent: Agent, oldModel: string): Match[] {
  const matches: Match[] = [];

  const adapterConfig = asRecord(agent.adapterConfig);
  if (adapterConfig && adapterConfig.model === oldModel) {
    matches.push({
      path: "adapterConfig.model",
      set: (root, value) => {
        const ac = asRecord(root.adapterConfig);
        if (ac) ac.model = value;
      },
    });
  }

  const runtimeConfig = asRecord(agent.runtimeConfig);
  if (runtimeConfig) {
    if (runtimeConfig.model === oldModel) {
      matches.push({
        path: "runtimeConfig.model",
        set: (root, value) => {
          const rc = asRecord(root.runtimeConfig);
          if (rc) rc.model = value;
        },
      });
    }

    const modelProfiles = asRecord(runtimeConfig.modelProfiles);
    if (modelProfiles) {
      for (const key of Object.keys(modelProfiles)) {
        const profile = asRecord(modelProfiles[key]);
        const profileAdapterConfig = profile ? asRecord(profile.adapterConfig) : null;
        if (profileAdapterConfig && profileAdapterConfig.model === oldModel) {
          matches.push({
            path: `runtimeConfig.modelProfiles.${key}.adapterConfig.model`,
            set: (root, value) => {
              const rc = asRecord(root.runtimeConfig);
              const p = rc ? asRecord(asRecord(rc.modelProfiles)?.[key]) : null;
              const pac = p ? asRecord(p.adapterConfig) : null;
              if (pac) pac.model = value;
            },
          });
        }
      }
    }
  }

  return matches;
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const oldModel = getFlag("old");
  const newModel = getFlag("new");
  const companyId = getFlag("company");
  const apply = args.includes("--apply");

  if (!oldModel || !newModel) {
    console.error("Usage: rename-agent-model.ts --old <modelId> --new <modelId> [--company <id>] [--apply]");
    process.exit(1);
  }

  const apiBase = process.env.PAPERCLIP_API_URL?.trim() || "http://localhost:3100";
  const credential = getStoredBoardCredential(apiBase);
  if (!credential) {
    console.error(`No stored credential for ${apiBase}. Run \`paperclip login\` first.`);
    process.exit(1);
  }

  const api = new PaperclipApiClient({ apiBase, apiKey: credential.token });

  let companyIds: string[];
  if (companyId) {
    companyIds = [companyId];
  } else {
    const companies = await api.get<Company[]>("/api/companies");
    if (!companies || companies.length === 0) {
      console.error(
        "GET /api/companies returned nothing. If this credential has board access " +
          "scoped to a specific company rather than instance-admin, pass --company <id> explicitly.",
      );
      process.exit(1);
    }
    companyIds = companies.map((c) => c.id);
  }

  console.log(`Scanning ${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"} for "${oldModel}"...\n`);

  let agentsScanned = 0;
  let agentsMatched = 0;
  let agentsPatched = 0;

  for (const cid of companyIds) {
    const agentsList = await api.get<Agent[]>(`/api/companies/${cid}/agents`);
    if (!agentsList) continue;

    for (const agent of agentsList) {
      agentsScanned += 1;
      const matches = findMatches(agent, oldModel);
      if (matches.length === 0) continue;

      agentsMatched += 1;
      console.log(`${agent.name} (${agent.id}, company ${cid}):`);
      for (const m of matches) console.log(`   ${m.path}`);

      if (!apply) continue;

      // Re-fetch immediately before mutating to avoid acting on a stale scan snapshot.
      const fresh = await api.get<Agent>(`/api/agents/${agent.id}`);
      if (!fresh) {
        console.log(`   SKIPPED: agent no longer found on re-fetch`);
        continue;
      }
      const freshMatches = findMatches(fresh, oldModel);
      if (freshMatches.length === 0) {
        console.log(`   SKIPPED: no longer matches on fresh re-fetch (already fixed?)`);
        continue;
      }

      const patch: Record<string, unknown> = {};
      const touchesAdapterConfig = freshMatches.some((m) => m.path === "adapterConfig.model");
      const touchesRuntimeConfig = freshMatches.some((m) => m.path !== "adapterConfig.model");

      if (touchesAdapterConfig) {
        patch.adapterConfig = { model: newModel };
      }
      if (touchesRuntimeConfig) {
        // runtimeConfig is replaced wholesale by the PATCH route, not merged --
        // deep-clone the full fresh object and mutate only the matched leaves.
        const mutableRoot: Record<string, unknown> = { runtimeConfig: JSON.parse(JSON.stringify(fresh.runtimeConfig ?? {})) };
        for (const m of freshMatches) {
          if (m.path === "adapterConfig.model") continue;
          m.set(mutableRoot, newModel);
        }
        patch.runtimeConfig = mutableRoot.runtimeConfig;
      }

      await api.patch(`/api/agents/${agent.id}`, patch);
      agentsPatched += 1;
      console.log(`   PATCHED -> ${newModel}`);
    }
  }

  console.log(
    `\nCompanies: ${companyIds.length} | Agents scanned: ${agentsScanned} | ` +
      `Matched: ${agentsMatched} | Patched: ${apply ? agentsPatched : 0}${apply ? "" : " (dry run -- pass --apply to patch)"}`,
  );

  console.log(`\nChecking source code for hardcoded defaults referencing "${oldModel}"...`);
  const { execSync } = await import("node:child_process");
  try {
    const grepOut = execSync(
      `grep -rn ${JSON.stringify(oldModel)} server/src packages/*/src 2>/dev/null || true`,
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
    );
    if (grepOut.trim()) {
      console.log("Manual follow-up needed (source code, not data -- this script cannot fix these):");
      console.log(grepOut.trim());
    } else {
      console.log("None found.");
    }
  } catch {
    console.log("(grep check skipped -- could not run)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
