import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { sendToTerminal } from './helpers/terminal'
import {
  getTerminalContentForPtyId,
  waitForPtyPaneMounted,
  waitForPtyShellEcho
} from './terminal-pty-readiness'

type TerminalColumnProbeWindow = Window & {
  __store?: {
    getState: () => {
      activeTabId?: string | null
      activeTabIdByWorktree?: Record<string, string | undefined>
      activeTabType?: string | null
      activeWorktreeId?: string | null
    }
  }
  __paneManagers?: Map<
    string,
    {
      getActivePane?: () => { terminal?: { cols?: number } } | null
      getPanes?: () => { terminal?: { cols?: number } }[]
    }
  >
}

export async function waitForRenderedTerminalColumnsAtMost(
  page: Page,
  maxCols: number,
  timeoutMs = 10_000
): Promise<number> {
  let observedCols = 0
  await expect
    .poll(
      async () => {
        observedCols = await page.evaluate(() => {
          const { __paneManagers: paneManagers, __store: store } =
            window as TerminalColumnProbeWindow
          const state = store?.getState()
          const worktreeId = state?.activeWorktreeId
          const tabId =
            state?.activeTabType === 'terminal'
              ? state.activeTabId
              : worktreeId
                ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                : null
          const manager = tabId ? paneManagers?.get(tabId) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.terminal?.cols ?? 0
        })
        return observedCols > 0 ? observedCols : maxCols + 1
      },
      {
        timeout: timeoutMs,
        message: `rendered terminal columns did not settle at or below ${maxCols}`
      }
    )
    .toBeLessThanOrEqual(maxCols)
  return observedCols
}

export async function waitForPtyColumnsAtMost(
  page: Page,
  ptyId: string,
  maxCols: number,
  timeoutMs = 30_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  await waitForPtyPaneMounted(page, ptyId, Math.min(10_000, timeoutMs))
  await waitForPtyShellEcho(page, ptyId, Math.min(15_000, Math.max(0, deadline - Date.now())))
  let markerObserved = false
  let lastObservedCols: number | null = null
  let lastMarker = ''
  let lastTerminalTail = ''
  while (Date.now() < deadline) {
    const marker = `ORCA_PTY_COLUMNS_${randomUUID()}`
    lastMarker = marker
    // Why: a few CI shells occasionally eat the first printable byte when a
    // command is written immediately after Ctrl+C/Ctrl+U. Split control bytes
    // from the probe command so the shell sees the whole `node` executable.
    await sendToTerminal(page, ptyId, '\x03')
    await page.waitForTimeout(50)
    await sendToTerminal(page, ptyId, '\x15')
    await page.waitForTimeout(50)
    await sendToTerminal(
      page,
      ptyId,
      `node -e ${JSON.stringify(`console.log('${marker}:' + (process.stdout.columns || 0))`)}\r`
    )
    const probeDeadline = Date.now() + Math.min(5_000, Math.max(0, deadline - Date.now()))
    while (Date.now() < probeDeadline) {
      const content = await getTerminalContentForPtyId(page, ptyId, 30_000)
      lastTerminalTail = content
      const match = content.match(new RegExp(`${marker}:(\\d+)`))
      const observedCols = Number(match?.[1] ?? 0)
      if (observedCols > 0) {
        markerObserved = true
        lastObservedCols = observedCols
        break
      }
      await page.waitForTimeout(100)
    }
    if (lastObservedCols !== null && lastObservedCols <= maxCols) {
      return lastObservedCols
    }
    const retryDelayMs = Math.min(250, Math.max(0, deadline - Date.now()))
    if (retryDelayMs > 0) {
      await page.waitForTimeout(retryDelayMs)
    }
  }
  lastTerminalTail = await getTerminalContentForPtyId(page, ptyId, 30_000)
  const finalState = {
    lastMarker,
    markerObserved,
    lastObservedCols,
    maxCols,
    terminalTail: lastTerminalTail.slice(-4_000)
  }
  if (!markerObserved) {
    throw new Error(
      `PTY column probe never observed a marker within ${timeoutMs}ms; final state ${JSON.stringify(
        finalState
      )}`
    )
  }
  throw new Error(
    `PTY columns stayed above ${maxCols}; last observed ${lastObservedCols}; final state ${JSON.stringify(
      finalState
    )}`
  )
}
