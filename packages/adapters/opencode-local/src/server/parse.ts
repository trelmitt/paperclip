import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

// A local model can fall into a token-repetition collapse: it emits the same token
// (observed: "!") until it exhausts max_tokens and returns finish_reason=length — a *clean*
// stop with exit 0. Without this guard the blob posts as an issue comment on a run that
// reports "succeeded", so it is invisible to failure metrics yet visibly garbage on the board.
// Detecting a runaway single-character run lets parse turn it into a run error (marking the run
// failed → surfaced in metrics + routed through the normal retry/continuation path) and drop the
// blob from the summary before it is posted.
// ponytail: single-character runaway only — the observed collapse mode. If phrase/line loops
// show up in the post-deploy data, extend findDegenerateRepetition to cover repeated n-grams.
const DEGENERATE_CHAR_RUN = 200;

export function findDegenerateRepetition(text: string): { message: string; index: number } | null {
  if (text.length < DEGENERATE_CHAR_RUN) return null;
  let runChar = "";
  let runLen = 0;
  let runStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === runChar) {
      runLen++;
      if (runLen >= DEGENERATE_CHAR_RUN) {
        const label =
          ch === "\n" ? "\\n" : ch === " " ? "space" : ch === "\t" ? "\\t" : JSON.stringify(ch);
        return {
          message: `degenerate model output: ${DEGENERATE_CHAR_RUN}+ consecutive ${label} characters (token-repetition loop) — output suppressed`,
          index: runStart,
        };
      }
    } else {
      runChar = ch;
      runLen = 1;
      runStart = i;
    }
  }
  return null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  let summary = messages.join("\n\n").trim();
  const degenerate = findDegenerateRepetition(summary);
  if (degenerate) {
    summary = `${summary.slice(0, degenerate.index).trimEnd()}\n\n[paperclip: ${degenerate.message}]`.trim();
    // Surface as a run error so the run is marked failed (visible in metrics) and routed
    // through the normal retry/continuation path instead of "succeeding" with a garbage comment.
    errors.push(degenerate.message);
  }

  return {
    sessionId,
    summary,
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
