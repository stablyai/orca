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

/**
 * Run a main-process `ElectronApplication.evaluate` that must not flake.
 *
 * Why: `ElectronApplication.evaluate` is unreliable on Electron 27+
 * (microsoft/playwright#33737) and can reject spuriously while the app is still
 * coming up — most often on the first call after `electron.launch()` resolves,
 * which is before the app is `ready`. Wrap only calls that are safe to repeat;
 * a closed app or a failed assertion still propagates on the first attempt.
 */
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
