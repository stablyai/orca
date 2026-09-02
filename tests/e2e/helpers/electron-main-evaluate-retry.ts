const MAIN_EVALUATE_ATTEMPTS = 5
const MAIN_EVALUATE_RETRY_MS = 200

/**
 * Playwright raises this message for any main-process CDP failure that is neither
 * a JS error nor a closed session, so it does not mean anything navigated — it is
 * also what a handle the main process has not finished publishing looks like.
 */
function isTransientMainEvaluateError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Execution context was destroyed')
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
