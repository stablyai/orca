// Why: queueMicrotask is used by the agent-status slice to schedule the
// freshness timer after state updates. In tests we need to flush microtasks
// before advancing fake timers so the setTimeout gets registered.
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}
