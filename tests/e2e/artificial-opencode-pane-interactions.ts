import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { ensureTerminalVisible } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

export type TerminalLoadPane = {
  paneKey: string
  ptyId: string
}

export async function focusActiveTerminalInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const textarea = pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!pane || !textarea) {
      throw new Error('Active terminal input is unavailable')
    }
    pane.terminal.focus()
    textarea.focus()
  })
}

export async function focusPane(page: Page, paneKey: string): Promise<void> {
  const separator = paneKey.indexOf(':')
  const tabId = paneKey.slice(0, separator)
  const leafId = paneKey.slice(separator + 1)
  await page.evaluate(
    ({ tabId, leafId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getPanes?.().find((candidate) => candidate.leafId === leafId)
      if (!manager || !pane) {
        throw new Error(`Unable to focus pane ${tabId}:${leafId}`)
      }
      manager.setActivePane?.(pane.id, { focus: true })
    },
    { tabId, leafId }
  )
}

export async function ensureActiveWorktreePaneLoad(
  page: Page,
  paneCount: number
): Promise<TerminalLoadPane[]> {
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  let snapshot = await waitForPaneIdentitySnapshot(page, 1)
  while (snapshot.panes.length < paneCount) {
    await splitActiveTerminalPane(page, snapshot.panes.length % 2 === 0 ? 'horizontal' : 'vertical')
    snapshot = await waitForPaneIdentitySnapshot(page, snapshot.panes.length + 1)
  }
  return snapshot.panes.slice(0, paneCount).map((pane) => ({
    paneKey: `${snapshot.tabId}:${pane.leafId}`,
    ptyId: pane.ptyId ?? ''
  }))
}

export async function waitForMarkerLatency(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (await activeTerminalTailContains(page, marker)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`)
}

// Marker probes only need recent text; serializing full scrollback can dominate the latency under test.
export async function activeTerminalTailContains(
  page: Page,
  expected: string,
  maxRows = 200
): Promise<boolean> {
  return page.evaluate(
    ({ expected, maxRows }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabs = worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []) : []
      const preferredTabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const tabId =
        preferredTabId && tabs.some((tab) => tab.id === preferredTabId)
          ? preferredTabId
          : (tabs[0]?.id ?? null)
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const buffer = pane?.terminal?.buffer?.active
      if (!buffer) {
        return false
      }
      const firstRow = Math.max(0, buffer.length - maxRows)
      let logicalHead = ''
      for (let row = buffer.length - 1; row >= firstRow; row -= 1) {
        const line = buffer.getLine(row)
        if (!line) {
          logicalHead = ''
          continue
        }
        logicalHead = line.translateToString(true) + logicalHead
        if (logicalHead.includes(expected)) {
          return true
        }
        logicalHead = line.isWrapped ? logicalHead.slice(0, expected.length) : ''
      }
      return false
    },
    { expected, maxRows }
  )
}

export async function getTerminalContentForPtyId(
  page: Page,
  ptyId: string,
  charLimit = 12_000
): Promise<string> {
  return page.evaluate(
    ({ ptyId, charLimit }) => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of manager.getPanes?.() ?? []) {
          if (pane.container?.dataset?.ptyId === ptyId) {
            return (pane.serializeAddon?.serialize?.() ?? '').slice(-charLimit)
          }
        }
      }
      return ''
    },
    { ptyId, charLimit }
  )
}

export async function waitForTerminalOutputForPtyId(
  page: Page,
  ptyId: string,
  expected: string,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(async () => (await getTerminalContentForPtyId(page, ptyId)).includes(expected), {
      timeout: timeoutMs,
      message: `Terminal PTY ${ptyId} did not contain "${expected}"`
    })
    .toBe(true)
}
