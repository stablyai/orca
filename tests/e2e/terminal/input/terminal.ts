import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import {
  readPaneIdentitySnapshot,
  resolveActiveTabId,
  type PaneIdentitySnapshot
} from '../layout/terminal-pane-identity'
import './terminal-active-pane'

import '../layout/terminal-pane-operations'

import './terminal-accessibility-tree'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Focus xterm’s helper textarea so keyboard.type reaches its PTY.
export async function focusActiveTerminalInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!state || !tabId || !pane) {
      throw new Error('No active terminal pane to focus')
    }
    state.setActiveTab(tabId)
    state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
    pane.terminal.focus()
    const textarea = pane.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!textarea) {
      throw new Error('Active terminal has no xterm helper textarea')
    }
    textarea.focus()
  })
}

export async function waitForActivePanePtyId(page: Page, timeoutMs = 15_000): Promise<string> {
  let resolvedPtyId: string | null = null
  await expect
    .poll(
      async () => {
        const tabId = await resolveActiveTabId(page)
        if (!tabId) {
          return null
        }

        resolvedPtyId = await page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return activePane?.container?.dataset?.ptyId ?? null
        }, tabId)
        return resolvedPtyId
      },
      {
        timeout: timeoutMs,
        message: 'Active terminal pane did not receive a PTY binding'
      }
    )
    .not.toBeNull()

  if (!resolvedPtyId) {
    throw new Error('waitForActivePanePtyId: active pane has no PTY binding')
  }
  return resolvedPtyId
}

export async function waitForPaneIdentitySnapshot(
  page: Page,
  paneCount: number
): Promise<PaneIdentitySnapshot> {
  let latestSnapshot: PaneIdentitySnapshot | null = null
  try {
    await expect
      .poll(
        async () => {
          latestSnapshot = await readPaneIdentitySnapshot(page)
          return Boolean(
            latestSnapshot &&
            latestSnapshot.panes.length === paneCount &&
            latestSnapshot.panes.every(
              (pane) =>
                UUID_RE.test(pane.leafId) &&
                pane.stablePaneId === pane.leafId &&
                pane.datasetLeafId === pane.leafId &&
                pane.ptyId !== null &&
                latestSnapshot?.ptyIdsByLeafId[pane.leafId] === pane.ptyId
            )
          )
        },
        {
          timeout: 15_000,
          message: 'Split terminal panes did not settle with UUID leaf-keyed PTY bindings'
        }
      )
      .toBe(true)
  } catch (error) {
    throw new Error(`Last pane identity snapshot: ${JSON.stringify(latestSnapshot)}`, {
      cause: error
    })
  }

  const snapshot = await readPaneIdentitySnapshot(page)
  if (!snapshot) {
    throw new Error('Pane identity snapshot disappeared after settling')
  }
  return snapshot
}
