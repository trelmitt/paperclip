import type { WorkspaceCommandDefinition } from "../types/workspace-runtime.js";

/**
 * A lightweight representation of a discovered command from a workspace
 * file (package.json scripts, Makefile targets).
 *
 * Used by discover() to return a uniform list of commands that callers
 * can convert to WorkspaceCommandDefinition themselves, or use as-is for
 * quick look-ups.
 */
export interface CommandInfo {
  /** Unique identifier, slugified, derived from the command name. */
  id: string;

  /** Display / search name. */
  name: string;

  /** One-line human-readable description (best-effort). */
  description: string;

  /** Raw command string, e.g. `"next dev"` or `"node server.js"`. */
  command: string;

  /** Working directory the command should run in, if any. */
  cwd?: string | null;

  /** Where the command was discovered from. */
  source: CommandSource;

  /** Optional tag(s) for filtering (e.g. "dev", "build", "test"). */
  tags?: string[];
}

/**
 * Denotes where a command was discovered.
 */
export interface CommandSource {
  /** The file that contained the command. */
  file: string;

  /** The key / identifier inside that file (script name, target name). */
  key: string;

  /** The type of source. */
  type: "package-json" | "makefile";

  /** Zero-based index among siblings from this source. */
  index: number;
}

/**
 * Coerce a raw string into a slugified id compatible with the workspace
 * command id convention used by workspace-commands.ts.
 */
function slugify(value: string | null | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "cmd";
}

/**
 * Ensure ids are unique within a batch by appending a source suffix when
 * needed, mirroring the dedup logic in workspace-commands.ts.
 */
function ensureUniqueIds(commands: CommandInfo[]): CommandInfo[] {
  const seen = new Set<string>();
  return commands.map((cmd) => {
    if (seen.has(cmd.id)) {
      const suffix = `${cmd.source.file}-${cmd.source.key}`;
      return { ...cmd, id: `${cmd.id}-${slugify(suffix)}` };
    }
    seen.add(cmd.id);
    return cmd;
  });
}

/**
 * Convert a CommandInfo into a WorkspaceCommandDefinition.
 *
 * Uses "service" as the default kind. Callers can override with the
 * optional `kind` parameter. The `source` field is translated to the
 * paperclip source format expected by workspace-commands.ts.
 */
export function commandInfoToWorkspaceCommand(
  info: CommandInfo,
  options?: { kind?: "service" | "job"; cwdOverride?: string | null },
): Omit<WorkspaceCommandDefinition, "rawConfig" | "lifecycle"> {
  return {
    id: info.id,
    name: info.name,
    kind: options?.kind ?? "service",
    command: info.command,
    cwd: options?.cwdOverride ?? info.cwd ?? null,
    lifecycle: null,
    serviceIndex: null,
    disabledReason: null,
    source: {
      type: "paperclip" as const,
      key: info.source.type === "package-json" ? "commands" : "services",
      index: info.source.index,
    },
  };
}

export { slugify, ensureUniqueIds };
