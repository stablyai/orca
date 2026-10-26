// Flush freshness-scheduling microtasks before advancing fake timers or no timeout is registered.
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}
