// ---------------------------------------------------------------------------
// Safety guard enforcement (pure — no node built-ins)
// ---------------------------------------------------------------------------
//
// Extracted from execution-target.ts so the browser-safe barrel (index.ts) can
// re-export checkShellCommandSafety without dragging in that module's node-only
// runtime stack (child_process/fs/net -> ssh -> git-workspace-sync). The UI
// imports the barrel, so anything reachable from it must stay browser-safe.

/**
 * Type alias for safety guard declaration to avoid circular dependency
 */
export type SafetyGuardDeclaration = {
  guardKey: string;
  displayName: string;
  description: string;
  blockPattern: string;
};

/**
 * Check if a shell command matches any blocked patterns in safety guards.
 * Returns the first matching guard key if blocked, or null if command is safe.
 */
export function checkShellCommandSafety(
  command: string,
  guards: Array<{ guardKey: string; displayName: string; description: string; blockPattern: string }>,
): string | null {
  for (const guard of guards) {
    try {
      const pattern = new RegExp(guard.blockPattern);
      if (pattern.test(command)) {
        return guard.guardKey;
      }
    } catch {
      // If the pattern is invalid, skip this guard
      continue;
    }
  }
  return null;
}
