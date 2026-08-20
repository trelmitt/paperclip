import { promises as fs } from "node:fs";
import { basename, resolve, isAbsolute } from "node:path";
import type { CommandInfo, CommandSource } from "./command-info.js";
import { slugify } from "./command-info.js";

const fs: typeof nodeFs = nodeFs;

/**
 * Represents a parsed Makefile target with metadata.
 */
export interface ParsedMakefileTarget {
  /** Target name (e.g. "build", "test"). */
  name: string;

  /** The recipe lines (without leading tabs) as a single command string. */
  command: string;

  /** Whether the target is declared in .PHONY. */
  phony: boolean;

  /** Any prerequisites listed after the target (e.g. dependencies). */
  prerequisites: string[];

  /** Comment or instruction associated with the target, if any. */
  description: string;

  /** Line number where the target rule starts (1-based). */
  startLine: number;
}

/**
 * Describes how Makefile targets should be filtered and interpreted.
 */
export interface MakefileTargetConfig {
  /** Path to the Makefile (absolute or relative to dirPath). Defaults to "Makefile". */
  makefilePath?: string;

  /** Target name prefixes to include. Empty = all targets. */
  includePrefixes?: string[];

  /** Target names to explicitly skip. */
  excludeNames?: string[];

  /** Only include targets declared .PHONY. */
  phonyOnly?: boolean;

  /** Tags to attach to every command discovered from this file. */
  tags?: string[];
}

/**
 * Default targets to skip — internal make constructs that are not user-facing commands.
 */
const DEFAULT_SKIP_TARGETS = new Set([
  "all",
  ".PHONY",
  ".DEFAULT",
  ".NOTPARALLEL",
  ".SILENT",
  ".DELETE_ON_ERROR",
  ".IGNORE",
  ".LOW_RESOLUTION_TIME",
  ".SECONDARY",
  ".SECONDEXPANSION",
  ".PRECIOUS",
  ".INTERMEDIATE",
  ".KEEP_OPEN",
  ".POSIX",
  "include",
  "-include",
  "sinclude",
  "export",
  "unexport",
  "override",
  "define",
  "endef",
  "vpath",
]);

/**
 * Generate a human-readable description for a Makefile target.
 */
function targetToDescription(name: string, phony: boolean): string {
  const normalized = name.toLowerCase().replace(/-/g, " ").replace(/^make /, "");
  const prefix = phony ? "[phony] " : "";

  if (["build", "test", "lint", "format", "clean", "start", "dev", "help", "deploy"].includes(normalized)) {
    return `${prefix}${normalized.charAt(0).toUpperCase() + normalized.slice(1)}`;
  }

  return `${prefix}${normalized.charAt(0).toUpperCase() + normalized.slice(1)} target`;
}

/**
 * Expand simple Makefile variables within a string.
 *
 * Handles $(VAR) and ${VAR} syntax. Only expands variables defined in the
 * same Makefile content. Nested/recursive expansion is not supported.
 */
function expandVariables(
  text: string,
  variables: Record<string, string>,
): string {
  return text.replace(/\$[\(\{]([a-zA-Z_][a-zA-Z0-9_]*)[\)\}]/g, (_match, varName) => {
    return variables[varName] ?? _match;
  });
}

/**
 * Parse a Makefile and extract executable targets as ParsedMakefileTarget entries.
 *
 * Skips:
 * - Variable assignments (lines with =, :=, ?=, !=)
 * - .PHONY and other special targets
 * - Pattern rules (targets containing %)
 * - Include directives
 */
export async function parseMakefile(
  dirPath: string,
  config?: MakefileTargetConfig,
): Promise<ParsedMakefileTarget[]> {
  const makefilePath = isAbsolute(config?.makefilePath ?? "")
    ? config.makefilePath
    : resolve(dirPath, config?.makefilePath ?? "Makefile");

  let content: string;
  try {
    content = await fs.readFile(makefilePath, "utf-8");
  } catch {
    return []; // No Makefile present
  }

  const lines = content.split(/\r?\n/);
  const variables: Record<string, string> = {};
  const phonyTargets: Set<string> = new Set();
  const allComments: Record<number, string> = {}; // line -> comment text

  // First pass: collect variables and .PHONY declarations
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track comments (non-indented lines starting with # or ;)
    if (trimmed.match(/^[#;]/)) {
      // Associate with next non-empty line
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine) {
          allComments[j + 1] = trimmed.replace(/^[#;]\s*/, "");
          break;
        }
      }
      continue;
    }

    // Variable assignment
    const varMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*[\:\?+]?=\s*(.*)/);
    if (varMatch) {
      variables[varMatch[1]] = varMatch[2].trim();
      continue;
    }

    // .PHONY declaration
    if (trimmed.startsWith(".PHONY")) {
      const phonyLine = trimmed.replace(/^\.(PHONY)\s*:\s*/, "");
      for (const name of phonyLine.split(/\s+/)) {
        if (name) phonyTargets.add(name);
      }
      continue;
    }

    // Skip other special targets
    if (trimmed.startsWith(".") && trimmed.match(/^\.([A-Z]+)\s*:/)) {
      continue;
    }
  }

  // Second pass: extract targets and recipes
  const targets: ParsedMakefileTarget[] = [];
  let currentTarget: ParsedMakefileTarget | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines, comments, variable assignments, includes
    if (!trimmed || trimmed.match(/^[#;]/) || trimmed.match(/^[a-zA-Z_].*[\:\?+]?=/)) {
      continue;
    }

    // Recipe line (starts with tab)
    if (line.startsWith("\t") || (line.startsWith("    ") && currentTarget)) {
      if (currentTarget) {
        const recipeLine = line.replace(/^\t|^(    )+/, "");
        currentTarget.command += currentTarget.command ? " " + recipeLine : recipeLine;
      }
      continue;
    }

    // End current target if we hit a non-recipe, non-target line
    if (currentTarget && !trimmed.includes(":")) {
      // Not a target line — finalize previous target
      if (currentTarget.command) {
        targets.push(currentTarget);
      }
      currentTarget = null;
      continue;
    }

    // Target rule line: target: prerequisites
    const targetMatch = trimmed.match(/^([^:=]+?)\s*:\s*(.*)/);
    if (!targetMatch) continue;

    const targetName = targetMatch[1].trim();
    const prerequisitesStr = targetMatch[2].trim();
    const prerequisites = prerequisitesStr.split(/\s+/).filter((p) => p.length > 0);

    // Skip pattern rules
    if (targetName.includes("%")) continue;

    // Expand variables in prerequisites
    const expandedPrereqs = prerequisites.map((p) => expandVariables(p, variables));

    // Check if this is a skip target
    const firstTargetName = targetName.split(" ")[0];
    if (DEFAULT_SKIP_TARGETS.has(firstTargetName)) continue;

    // Check exclude filter
    if (config?.excludeNames && config.excludeNames.includes(targetName)) continue;

    // Check include prefix filter
    if (config?.includePrefixes && config.includePrefixes.length > 0) {
      const matched = config.includePrefixes.some((prefix) => targetName.startsWith(prefix));
      if (!matched) continue;
    }

    currentTarget = {
      name: targetName,
      command: "",
      phony: phonyTargets.has(firstTargetName),
      prerequisites: expandedPrereqs,
      description: "", // filled below
      startLine: i + 1,
    };
  }

  // Finalize any remaining target
  if (currentTarget && currentTarget.command) {
    targets.push(currentTarget);
  }

  // Fill in descriptions and apply phony-only filter
  for (const target of targets) {
    target.description = targetToDescription(target.name, target.phony);

    // Add comment description if available
    const comment = allComments[target.startLine];
    if (comment) {
      target.description = `${comment} — ${target.description}`;
    }

    // Add recipe as description fallback if no comment
    if (!comment && target.command.length > 50) {
      // Truncate long recipe strings in description
      target.description = `${target.command.slice(0, 50)}...`;
    }
  }

  // Apply phony-only filter
  if (config?.phonyOnly) {
    return targets.filter((t) => t.phony);
  }

  return targets;
}

/**
 * Parse a Makefile and return executable targets as CommandInfo entries.
 */
export async function discoverMakefileTargets(
  dirPath: string,
  config?: MakefileTargetConfig,
): Promise<CommandInfo[]> {
  const parsedTargets = await parseMakefile(dirPath, config);

  const makefilePath = isAbsolute(config?.makefilePath ?? "")
    ? config.makefilePath
    : resolve(dirPath, config?.makefilePath ?? "Makefile");

  const results: CommandInfo[] = parsedTargets.map((target, index) => ({
    id: `make:${slugify(target.name)}`,
    name: target.name,
    description: target.description,
    command: target.command || `make ${target.name}`,
    cwd: dirPath,
    source: {
      file: basename(makefilePath),
      key: target.name,
      type: "makefile",
      index,
    },
    tags: config?.tags,
  }));

  return results;
}
