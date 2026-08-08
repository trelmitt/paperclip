import { describe, expect, it } from "vitest";
import { createSingleFlight } from "../lib/single-flight.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createSingleFlight", () => {
  it("skips overlapping calls while a task is in flight", async () => {
    const sf = createSingleFlight();
    const gate = deferred();
    let runs = 0;

    const first = sf.run(() => {
      runs += 1;
      return gate.promise;
    });
    expect(sf.active).toBe(true);

    // Second call while the first is still pending is skipped, not run.
    await sf.run(async () => {
      runs += 1;
    });
    expect(runs).toBe(1);
    expect(sf.active).toBe(true);

    gate.resolve();
    await first;
    expect(sf.active).toBe(false);
  });

  it("runs again once the prior task completes", async () => {
    const sf = createSingleFlight();
    let runs = 0;
    await sf.run(async () => {
      runs += 1;
    });
    await sf.run(async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });

  it("resets after a rejected task so later calls run", async () => {
    const sf = createSingleFlight();
    await expect(
      sf.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sf.active).toBe(false);

    let ran = false;
    await sf.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("resets after a synchronous throw in the task", async () => {
    const sf = createSingleFlight();
    await expect(
      sf.run((() => {
        throw new Error("sync");
      }) as unknown as () => Promise<void>),
    ).rejects.toThrow("sync");
    expect(sf.active).toBe(false);
  });
});
