import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError, findDegenerateRepetition } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("suppresses a token-repetition collapse and marks it a run error", () => {
    // The observed doom-loop: real text, then a runaway "!" blob until max_tokens.
    const text = `I'll get grounded quickly, then act. Let me check the${"!".repeat(4000)}`;
    const stdout = JSON.stringify({
      type: "text",
      sessionID: "session_x",
      part: { text },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    // The blob is dropped; the useful prefix is kept with a suppression marker.
    expect(parsed.summary).not.toContain("!!!!!!!!");
    expect(parsed.summary).toContain("Let me check the");
    expect(parsed.summary).toContain("[paperclip:");
    // It becomes a run error so the run is marked failed (not a silent "succeeded").
    expect(parsed.errorMessage).toContain("degenerate model output");
  });

  it("does not flag normal output or legit short repeated separators", () => {
    expect(findDegenerateRepetition("A normal answer with some prose.")).toBeNull();
    // A 100-char markdown-style rule is under the 200 threshold — must not false-trip.
    expect(findDegenerateRepetition(`before\n${"-".repeat(100)}\nafter`)).toBeNull();
    // A true runaway is caught.
    expect(findDegenerateRepetition("x".repeat(250))?.index).toBe(0);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});
