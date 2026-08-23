import type { ElectronApplication, Page } from '@stablyai/playwright-test'

/**
 * Reveals a paired client's window so its renderer unparks runtime subscriptions. Leave the client
 * hidden only when the hidden state is what the spec covers.
 */
export type PairedClientWindowRevealReport = {
  isVisible: boolean
  wasVisible: boolean
  windowCount: number
}

export type RevealablePairedClient = {
  app: ElectronApplication
  page: Page
}

export function assertPairedClientWindowRevealed(report: PairedClientWindowRevealReport): void {
  if (report.windowCount === 0) {
    throw new Error('Paired client has no BrowserWindow to reveal')
  }
  if (!report.isVisible) {
    throw new Error(
      `Paired client window stayed hidden after show() (windows: ${report.windowCount})`
    )
  }
}

export async function revealPairedClientWindow(
  client: RevealablePairedClient
): Promise<PairedClientWindowRevealReport> {
  const report = await client.app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const window = windows[0]
    const wasVisible = window?.isVisible() ?? false
    if (window && !wasVisible) {
      window.show()
    }
    return {
      isVisible: window?.isVisible() ?? false,
      wasVisible,
      windowCount: windows.length
    }
  })
  assertPairedClientWindowRevealed(report)
  // Why: the renderer unparks on `visibilitychange`; clicking before it lands races a parked
  // host list.
  await client.page.waitForFunction(() => document.visibilityState === 'visible', null, {
    timeout: 30_000
  })
  return report
}
