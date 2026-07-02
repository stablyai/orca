import type { Page } from '@stablyai/playwright-test'

export const STRETCHED_HIDDEN_OUTPUT_FALLBACK_MS = 3_000

type TimeoutStretchWindow = Window & {
  __terminalTabOverlapOriginalSetTimeout?: typeof window.setTimeout
}

export async function stretchFiveHundredMillisecondTimeouts(page: Page): Promise<void> {
  await page.evaluate((stretchedDelayMs) => {
    const testWindow = window as TimeoutStretchWindow
    if (testWindow.__terminalTabOverlapOriginalSetTimeout) {
      return
    }
    const originalSetTimeout = window.setTimeout
    const boundSetTimeout = originalSetTimeout.bind(window)
    testWindow.__terminalTabOverlapOriginalSetTimeout = originalSetTimeout
    // Why: terminal reveal recovery tests must prove reveal repaint, so the old
    // hidden-output fallback is stretched out of the assertion window.
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      boundSetTimeout(
        handler,
        timeout === 500 ? stretchedDelayMs : timeout,
        ...args
      )) as typeof window.setTimeout
  }, STRETCHED_HIDDEN_OUTPUT_FALLBACK_MS)
}

export async function restoreFiveHundredMillisecondTimeouts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as TimeoutStretchWindow
    if (!testWindow.__terminalTabOverlapOriginalSetTimeout) {
      return
    }
    window.setTimeout = testWindow.__terminalTabOverlapOriginalSetTimeout
    delete testWindow.__terminalTabOverlapOriginalSetTimeout
  })
}
