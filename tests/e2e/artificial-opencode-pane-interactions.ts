import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, switchToWorktree } from './helpers/store'
import {
  getTerminalContent,
  readPaneIdentitySnapshot,
  splitActiveTerminalPane,
  UUID_RE,
  waitForActiveTerminalManager,
  type PaneIdentitySnapshot
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

export async function waitForTerminalPtyVisible(
  page: Page,
  ptyId: string,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((targetPtyId) => {
          for (const manager of window.__paneManagers?.values() ?? []) {
            const pane = manager
              .getPanes?.()
              .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
            if (pane) {
              return pane.container.isConnected && pane.container.getClientRects().length > 0
            }
          }
          return false
        }, ptyId),
      {
        timeout: timeoutMs,
        message: `Terminal PTY ${ptyId} did not become visible`
      }
    )
    .toBe(true)
}

export async function ensureActiveWorktreePaneLoad(
  page: Page,
  paneCount: number
): Promise<TerminalLoadPane[]> {
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const worktreeId = await getActiveWorktreeId(page)
  if (!worktreeId) {
    throw new Error('Active worktree is unavailable for terminal pane load')
  }
  let snapshot = await waitForActiveWorktreePaneLoad(page, worktreeId, 1)
  while (snapshot.panes.length < paneCount) {
    await splitActiveTerminalPane(page, snapshot.panes.length % 2 === 0 ? 'horizontal' : 'vertical')
    snapshot = await waitForActiveWorktreePaneLoad(page, worktreeId, snapshot.panes.length + 1)
  }
  return snapshot.panes.slice(0, paneCount).map((pane) => ({
    paneKey: `${snapshot.tabId}:${pane.leafId}`,
    ptyId: pane.ptyId ?? ''
  }))
}

async function waitForActiveWorktreePaneLoad(
  page: Page,
  worktreeId: string,
  paneCount: number
): Promise<PaneIdentitySnapshot> {
  let snapshot: PaneIdentitySnapshot | null = null
  await expect
    .poll(
      async () => {
        if ((await getActiveWorktreeId(page)) !== worktreeId) {
          // Why: late session reconciliation can clear selection while split PTYs bind.
          await switchToWorktree(page, worktreeId)
          await ensureTerminalVisible(page)
          await waitForActiveTerminalManager(page, 30_000)
        }
        snapshot = await readPaneIdentitySnapshot(page)
        return Boolean(
          snapshot &&
          snapshot.panes.length === paneCount &&
          snapshot.panes.every(
            (pane) =>
              UUID_RE.test(pane.leafId) &&
              pane.stablePaneId === pane.leafId &&
              pane.datasetLeafId === pane.leafId &&
              pane.ptyId !== null &&
              snapshot?.ptyIdsByLeafId[pane.leafId] === pane.ptyId
          )
        )
      },
      {
        timeout: 15_000,
        message: 'Artificial load panes did not settle with stable PTY bindings'
      }
    )
    .toBe(true)
  if (!snapshot) {
    throw new Error('Artificial load pane snapshot is unavailable')
  }
  return snapshot
}

export async function waitForMarkerLatency(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if ((await getTerminalContent(page, 12_000)).includes(marker)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`)
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
