import { resolve } from "node:path";
import type { CommandInfo } from "./command-info.js";
import { ensureUniqueIds } from "./command-info.js";
import { discoverPackageJsonScripts, type PackageJsonScriptConfig } from "./package-json.js";
import { discoverMakefileTargets, type MakefileTargetConfig } from "./makefile.js";

/**
 * Source selection configuration. Each property is optional; omit a source to
 * skip it entirely, or pass an empty object to enable all sources with defaults.
 */
export interface CommandDiscoveryConfig {
  /** Package.json script discovery config. Omit to disable. */
  packageJson?: false | PackageJsonScriptConfig;

  /** Makefile target discovery config. Omit to disable. */
  makefile?: false | MakefileTargetConfig;

  /** Working directory to search from. Defaults to process.cwd(). */
  cwd?: string;

  /** Target file to treat as package.json (relative to cwd). */
  packageJsonFile?: string;

  /** Target file to treat as Makefile (relative to cwd). */
  makefilePath?: string;
}

/**
 * Default config when a source is enabled without explicit options.
 */
const DEFAULT_PACKAGE_JSON_CONFIG: PackageJsonScriptConfig = {
  packageJsonPath: "package.json",
};

const DEFAULT_MAKEFILE_CONFIG: MakefileTargetConfig = {
  makefilePath: "Makefile",
};

/**
 * Discover commands from available workspace files.
 *
 * Aggregates:
 * - npm/yarn/pnpm scripts from package.json
 * - Makefile targets
 *
 * Sources are searched in priority order (highest first):
 * 1. package.json scripts
 * 2. Makefile targets
 *
 * @param config - Discovery configuration. Default: search cwd for package.json and Makefile.
 * @returns Array of CommandInfo entries with deduplicated ids.
 */
export async function discover(config?: CommandDiscoveryConfig): Promise<CommandInfo[]> {
  const cwd = resolve(config?.cwd ?? process.cwd());
  const all: CommandInfo[] = [];

  // Enable package.json script discovery
  if (!config?.packageJson) {
    // Default: enable with defaults but only package.json scripts
  }
  const pkgConfig = config?.packageJson === false ? null : {
    ...DEFAULT_PACKAGE_JSON_CONFIG,
    ...(typeof config?.packageJson === "object" ? config.packageJson : {}),
  };

  if (pkgConfig) {
    const pkgPath = resolve(cwd, pkgConfig.packageJsonPath ?? "package.json");
    // derive dir from full path
    const pkgDir = pkgPath.includes("package.json")
      ? cwd
      : resolve(cwd, pkgConfig.packageJsonPath ?? ".");

    // If packageJsonPath is specified as a full path, use its directory
    let searchDir = cwd;
    if (pkgConfig.packageJsonPath) {
      const absPath = resolve(cwd, pkgConfig.packageJsonPath);
      if (absPath.endsWith("package.json")) {
        searchDir = absPath.replace(/\/?package\.json$/, "");
      } else {
        searchDir = absPath;
      }
    }

    const scripts = await discoverPackageJsonScripts(searchDir, pkgConfig);
    all.push(...scripts);
  }

  // Enable Makefile target discovery
  if (!config?.makefile) {
    // Default: don't enable makefile unless explicitly requested
  } else if (config.makefile !== false) {
    const mkConfig: MakefileTargetConfig = {
      ...DEFAULT_MAKEFILE_CONFIG,
      ...(typeof config.makefile === "object" ? config.makefile : {}),
    };

    const makeDir = cwd;
    const targets = await discoverMakefileTargets(makeDir, mkConfig);
    all.push(...targets);
  }

  // Deduplicate by id (commands may appear in both sources)
  return ensureUniqueIds(all);
}

/**
 * Discover commands from package.json scripts only.
 */
export async function discoverScripts(
  dirPath?: string,
  config?: PackageJsonScriptConfig,
): Promise<CommandInfo[]> {
  const cwd = resolve(dirPath ?? config?.cwd ?? process.cwd());
  return discoverPackageJsonScripts(cwd, { ...config, cwd: dirPath ?? config?.cwd });
}

/**
 * Discover commands from Makefile targets only.
 */
export async function discoverTargets(
  dirPath?: string,
  config?: MakefileTargetConfig,
): Promise<CommandInfo[]> {
  const cwd = resolve(dirPath ?? config?.makefilePath ?? process.cwd());
  return discoverMakefileTargets(cwd, { ...config, makefilePath: dirPath ? "Makefile" : config?.makefilePath });
}

// Re-export types for convenience
export type { CommandInfo, CommandSource, ParsedMakefileTarget } from "./command-info.js";
export type { PackageJsonScriptConfig } from "./package-json.js";
export type { MakefileTargetConfig } from "./makefile.js";
