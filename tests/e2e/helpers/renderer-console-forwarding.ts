import type { Page, TestInfo } from '@stablyai/playwright-test'

/**
 * Renderer-side counterpart of `forwardElectronProcessLogs`, sharing its
 * `ORCA_E2E_FORWARD_APP_LOGS` gate.
 *
 * Why: a contained render crash only ever reaches the renderer console
 * (`RecoverableRenderErrorBoundary` logs the error plus its component stack
 * there), so without this a boundary failure leaves nothing but a screenshot of
 * the dialog and the stack that would localize the first bad render is lost.
 */
export function forwardRendererConsole(page: Page, testInfo: TestInfo): void {
  if (process.env.ORCA_E2E_FORWARD_APP_LOGS !== '1') {
    return
  }

  const prefix = `[renderer:${testInfo.title}]`
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`${prefix} ${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    console.error(`${prefix} pageerror: ${error.stack ?? error.message}`)
  })
}
