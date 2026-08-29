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

export type PairedClientWindowFocusReport = PairedClientWindowRevealReport & { isFocused: boolean }

/**
 * Brings a paired client to the front, which a launched-but-background window never is. Main-side
 * policies that ask whether the reader is looking at a WebContents read the OS focus state, so a
 * spec driving real presses through such a policy has to put the window there first.
 */
export async function focusPairedClientWindow(
  client: RevealablePairedClient,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {}
): Promise<PairedClientWindowFocusReport> {
  const revealed = await revealPairedClientWindow(client)
  const deadline = Date.now() + timeoutMs
  let isFocused = false
  while (!isFocused) {
    isFocused = await client.app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      // Why steal: nothing else in the run is asking for the front, and the window manager keeps
      // the launching terminal there otherwise.
      app.focus({ steal: true })
      window?.focus()
      return window?.isFocused() ?? false
    })
    if (isFocused || Date.now() >= deadline) {
      break
    }
    await client.page.waitForTimeout(250)
  }
  return { ...revealed, isFocused }
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
