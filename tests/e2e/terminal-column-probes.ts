import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { getTerminalContent, sendToTerminal } from './helpers/terminal'

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
  let observedCols = 0
  while (Date.now() < deadline) {
    const marker = `ORCA_PTY_COLUMNS_${randomUUID()}`
    await sendToTerminal(
      page,
      ptyId,
      `\x03\x15node -e ${JSON.stringify(
        `console.log('${marker}:' + (process.stdout.columns || 0))`
      )}\r`
    )
    const probeDeadline = Date.now() + Math.min(3_000, Math.max(1_000, deadline - Date.now()))
    while (Date.now() < probeDeadline) {
      const content = await getTerminalContent(page, 30_000)
      const match = content.match(new RegExp(`${marker}:(\\d+)`))
      observedCols = Number(match?.[1] ?? 0)
      if (observedCols > 0) {
        break
      }
      await page.waitForTimeout(100)
    }
    if (observedCols > 0 && observedCols <= maxCols) {
      return observedCols
    }
    await page.waitForTimeout(250)
  }
  throw new Error(`PTY columns stayed above ${maxCols}; last observed ${observedCols}`)
}
