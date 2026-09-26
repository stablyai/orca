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
      `Paired client window stayed hidden after showInactive() (windows: ${report.windowCount})`
    )
  }
}

export type PairedClientWindowFocusReport = PairedClientWindowRevealReport & { isFocused: boolean }

/**
 * Native-focus coverage must run on an isolated display or CI, never in background mode.
 */
export async function focusPairedClientWindow(
  client: RevealablePairedClient,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {}
): Promise<PairedClientWindowFocusReport> {
  await client.app.evaluate(() => {
    if (process.env.ORCA_BACKGROUND_LAUNCH === '1') {
      throw new Error('Native focus is forbidden by ORCA_BACKGROUND_LAUNCH')
    }
  })
  const revealed = await revealPairedClientWindow(client)
  const deadline = Date.now() + timeoutMs
  let isFocused = false
  while (!isFocused) {
    isFocused = await client.app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      // Native-focus coverage requires a dedicated foreground session.
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
    if (process.env.ORCA_BACKGROUND_LAUNCH === '1') {
      throw new Error('Window reveal is forbidden by ORCA_BACKGROUND_LAUNCH')
    }
    const windows = BrowserWindow.getAllWindows()
    const window = windows[0]
    const wasVisible = window?.isVisible() ?? false
    // Why showInactive: the renderer only needs `visibilityState === 'visible'`;
    // show() would also raise the window over whatever the developer is doing.
    if (window && !wasVisible) {
      window.showInactive()
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
