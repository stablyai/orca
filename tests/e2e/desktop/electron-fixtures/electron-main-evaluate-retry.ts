const MAIN_EVALUATE_ATTEMPTS = 5
const MAIN_EVALUATE_RETRY_MS = 200

// Startup can invalidate the CDP context or collect a pending evaluation promise.
function isTransientMainEvaluateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('Execution context was destroyed') ||
      error.message.includes('Resulting promise was garbage collected'))
  )
}

function waitBeforeRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MAIN_EVALUATE_RETRY_MS))
}

// Retry only repeatable startup evaluations affected by transient Electron 27+ CDP failures (playwright#33737).
// Closed-app errors and failed assertions still propagate immediately.
export async function retryTransientMainEvaluate<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt < MAIN_EVALUATE_ATTEMPTS; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isTransientMainEvaluateError(error)) {
        throw error
      }
      await waitBeforeRetry()
    }
  }
  return run()
}
