import { promises as fs } from "node:fs";
import { basename, resolve, isAbsolute } from "node:path";
import type { CommandInfo, CommandSource } from "./command-info.js";
import { slugify } from "./command-info.js";

/**
 * Describes how package.json scripts should be interpreted.
 */
export interface PackageJsonScriptConfig {
  /** Path to the package.json file (absolute or relative to cwd). Defaults to "package.json". */
  packageJsonPath?: string;

  /** Script names or prefixes to include. Empty = all scripts. */
  includePrefixes?: string[];

  /** Script names to explicitly skip. */
  excludeNames?: string[];

  /** Override the default working directory (defaults to the directory containing package.json). */
  cwd?: string;

  /** Tags to attach to every command discovered from this file. */
  tags?: string[];
}

/**
 * Known npm script prefixes and their associated tag.
 */
const KNOWN_PREFIXES: Record<string, string> = {
  "pre": "pre",
  "post": "post",
  "start": "dev",
  "dev": "dev",
  "build": "build",
  "test": "test",
  "lint": "lint",
  "format": "format",
  "typecheck": "type-check",
  "tsc": "type-check",
  "clean": "build",
  "setup": "setup",
  "migrate": "migrate",
  "seed": "db",
  "db": "db",
};

/**
 * Generate a human-readable description for an npm script name.
 */
function scriptNameToScriptDescription(scriptName: string): string {
  const normalized = scriptName.toLowerCase().replace(/-/g, " ");

  if (normalized.startsWith("pre ") || normalized.startsWith("post ")) {
    const action = normalized.replace(/^pre /, "before running ").replace(/^post /, "after running ");
    return `${action}${scriptName.slice(normalized.length)}`;
  }

  // Try matching known prefixes first
  for (const [prefix, tag] of Object.entries(KNOWN_PREFIXES)) {
    if (tag === "pre" || tag === "post") continue;
    if (scriptName.toLowerCase() === prefix || scriptName.toLowerCase().startsWith(prefix + "-")) {
      return `${tag.replace("-", " ")}${scriptName === prefix ? "" : ": " + scriptName.slice(prefix.length + 1)}`;
    }
  }

  // Generic fallback: capitalise the first letter
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Parse a package.json file and extract scripts as CommandInfo entries.
 */
export async function parsePackageJson(
  dirPath: string,
  config?: PackageJsonScriptConfig,
): Promise<CommandInfo[]> {
  const packageJsonPath = isAbsolute(config?.packageJsonPath ?? "")
    ? config.packageJsonPath
    : resolve(dirPath, config?.packageJsonPath ?? "package.json");

  let content: string;
  try {
    content = await fs.readFile(packageJsonPath, "utf-8");
  } catch {
    return []; // No package.json present
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(content);
  } catch {
    return []; // Invalid JSON
  }

  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object") return [];

  const excludeSet = new Set(config?.excludeNames ?? []);
  const entries = Object.entries(scripts);
  nextEntry: for (const [name, cmd] of entries) {
    if (typeof cmd !== "string") continue;
    if (excludeSet.has(name)) continue;

    // Filter by include prefixes (if specified, only match scripts starting with one)
    if (config?.includePrefixes && config.includePrefixes.length > 0) {
      const matched = config.includePrefixes.some((prefix) => name.startsWith(prefix));
      if (!matched) continue;
    }

    results.push({
      id: `pkg-script:${slugify(name)}`,
      name: name,
      description: scriptNameToScriptDescription(name),
      command: cmd.trim(),
      cwd: config?.cwd ?? dirPath,
      source: {
        file: basename(packageJsonPath),
        key: name,
        type: "package-json",
        index: -1, // will be set by the caller / discover
      },
      tags: config?.tags,
    });
  }

  return results;
}

/**
 * Parse a package.json file and return all scripts as CommandInfo entries.
 */
export async function discoverPackageJsonScripts(
  dirPath: string,
  config?: PackageJsonScriptConfig,
): Promise<CommandInfo[]> {
  const results: CommandInfo[] = [];
  for await (const cmd of parsePackageJson(dirPath, config)) {
    results.push(cmd);
  }

  // Assign sequential indices now that we have the final array
  for (let i = 0; i < results.length; i++) {
    results[i].source.index = i;
  }

  return results;
}
