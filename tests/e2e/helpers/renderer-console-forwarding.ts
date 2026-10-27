import type { Page, TestInfo } from '@stablyai/playwright-test'

// Forward renderer boundary errors and component stacks under ORCA_E2E_FORWARD_APP_LOGS; screenshots alone lose the failing render stack.
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
