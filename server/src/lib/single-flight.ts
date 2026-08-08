// A single-flight (reentrancy) guard: while one invocation of the wrapped task
// is in flight, overlapping calls are skipped instead of run concurrently.
//
// The heartbeat scheduler runs on a fixed setInterval. If a tick takes longer
// than the interval, the next interval fires before the previous tick settles
// and the two run concurrently, re-dispatching the same reconcile sweeps. This
// guard lets the scheduler skip a tick while the prior one is still in flight.
export interface SingleFlight {
  /** Run `task` unless a prior run is still in flight, in which case resolve without running it. */
  run(task: () => Promise<void>): Promise<void>;
  /** Whether a run is currently in flight. */
  readonly active: boolean;
}

export function createSingleFlight(): SingleFlight {
  let active = false;
  return {
    run(task) {
      if (active) return Promise.resolve();
      active = true;
      let started: Promise<void>;
      try {
        started = Promise.resolve(task());
      } catch (err) {
        // A synchronous throw must not leave the guard stuck active.
        active = false;
        return Promise.reject(err);
      }
      return started.finally(() => {
        active = false;
      });
    },
    get active() {
      return active;
    },
  };
}
