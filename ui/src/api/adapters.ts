/**
 * @fileoverview Frontend API client for external adapter management.
 */

import { api } from "./client";

export interface AdapterCapabilities {
  supportsInstructionsBundle: boolean;
  supportsSkills: boolean;
  supportsLocalAgentJwt: boolean;
  requiresMaterializedRuntimeSkills: boolean;
  supportsModelProfiles: boolean;
  supportsAcp: boolean;
}

export interface AcpTargetDescriptor {
  agentId: string;
  skillsMode: "ephemeral" | "unsupported";
  prerequisites: {
    nodeRange?: string;
    packages?: string[];
  };
}

export interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  capabilities: AdapterCapabilities;
  acp?: AcpTargetDescriptor;
  /** Installed version (for external npm adapters) */
  version?: string;
  /** Package name (for external adapters) */
  packageName?: string;
  /** Whether the adapter was installed from a local path (vs npm). */
  isLocalPath?: boolean;
  /** True when an external plugin has replaced a built-in adapter of the same type. */
  overriddenBuiltin?: boolean;
  /** True when the external override for a builtin type is currently paused. */
  overridePaused?: boolean;
}

export interface AdapterInstallResult {
  type: string;
  packageName: string;
  version?: string;
  installedAt: string;
}

export interface AdapterInstalledInfo {
  type: string;
  /** The runtime CLI the adapter looks for on PATH, or null if it has none. */
  detectCommand: string | null;
  /** Whether that CLI resolves on the server host's PATH; null when unknown. */
  installed: boolean | null;
}

export const adaptersApi = {
  /** List all registered adapters (built-in + external). */
  list: () => api.get<AdapterInfo[]>("/adapters"),

  /** Report which enabled adapters have their runtime CLI on the server host's PATH. */
  detectInstalled: () => api.get<AdapterInstalledInfo[]>("/adapters/detect-installed"),

  /** Install an external adapter from npm or a local path. */
  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<AdapterInstallResult>("/adapters/install", params),

  /** Remove an external adapter by type. */
  remove: (type: string) => api.delete<{ type: string; removed: boolean }>(`/adapters/${type}`),

  /** Enable or disable an adapter (disabled adapters hidden from agent menus). */
  setDisabled: (type: string, disabled: boolean) =>
    api.patch<{ type: string; disabled: boolean; changed: boolean }>(`/adapters/${type}`, { disabled }),

  /** Pause or resume an external override of a builtin type. */
  setOverridePaused: (type: string, paused: boolean) =>
    api.patch<{ type: string; paused: boolean; changed: boolean }>(`/adapters/${type}/override`, { paused }),

  /** Reload an external adapter (bust server + client caches). */
  reload: (type: string) =>
    api.post<{ type: string; version?: string; reloaded: boolean }>(`/adapters/${type}/reload`, {}),

  /** Reinstall an npm-sourced adapter (pulls latest from registry, then reloads). */
  reinstall: (type: string) =>
    api.post<{ type: string; version?: string; reinstalled: boolean }>(`/adapters/${type}/reinstall`, {}),
};
