import { afterEach, describe, expect, it } from "vitest";

import {
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  orderPromptSectionsForCache,
} from "./execute.js";

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("orderPromptSectionsForCache", () => {
  const parts = {
    instructionsPrefix: "INSTR", // static (per-agent file)
    renderedPrompt: "CONTRACT", // stable (per-agent standing contract)
    renderedBootstrapPrompt: "BOOTSTRAP", // volatile (runId)
    sessionHandoffNote: "HANDOFF", // volatile
    wakePrompt: "WAKE", // volatile (freshest)
  };

  it("orders stable sections before volatile ones (KV prefix-cache invariant)", () => {
    const ordered = orderPromptSectionsForCache(parts);
    expect(ordered).toEqual(["INSTR", "CONTRACT", "BOOTSTRAP", "HANDOFF", "WAKE"]);
    // The regression this guards: the standing contract (stable) must precede the volatile
    // per-run sections, or the ~1500-token contract can never enter the cached prefix.
    expect(ordered.indexOf("CONTRACT")).toBeLessThan(ordered.indexOf("BOOTSTRAP"));
    expect(ordered.indexOf("CONTRACT")).toBeLessThan(ordered.indexOf("WAKE"));
    // Wake (the freshest, most specific instruction) lands last.
    expect(ordered[ordered.length - 1]).toBe("WAKE");
  });

  it("preserves all sections (order-only; content unchanged)", () => {
    const ordered = orderPromptSectionsForCache(parts);
    expect([...ordered].sort()).toEqual(Object.values(parts).sort());
  });
});
