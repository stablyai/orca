/** Synchronous readers and finite host publication share the same projection. */
export function finishAgentSessionSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done) {
      return next.value
    }
  }
}
