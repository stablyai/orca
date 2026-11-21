import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

type TerminalPtyDataInjectionWindow = Window & {
  __terminalPtyDataInjection?: {
    keys: () => string[]
  }
}

export async function waitForTerminalPtyDataInjector(
  page: Page,
  paneKey: string,
  timeoutMs = 15_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((targetPaneKey) => {
          const injector = (window as TerminalPtyDataInjectionWindow).__terminalPtyDataInjection
          return injector?.keys().includes(targetPaneKey) ?? false
        }, paneKey),
      {
        timeout: timeoutMs,
        // Pane routing can settle before TerminalPane registers its E2E data injector.
        message: `terminal PTY data injector did not register for ${paneKey}`
      }
    )
    .toBe(true)
}
