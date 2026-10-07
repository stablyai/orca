/**
 * A pane closed just before quit must stay closed after relaunch.
 *
 * Why this suite exists: closing a pane asks the terminal daemon to kill its shell, and on macOS
 * that kill waits out a descendant grace before it finishes. Quitting inside that window left the
 * daemon listing the dying session as live, so the relaunched app adopted it as an extra tab and its
 * attach spawned a fresh shell under the closed id.
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { bootstrapFirstLaunch, seededRepoPathOrSkip } from './helpers/terminal-restart-persistence'
import { ensureTerminalVisible, getActiveWorktreeId, waitForSessionReady } from './helpers/store'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'

test.describe.configure({ mode: 'serial' })

type BoundPane = { leafId: string; ptyId: string }

/** Setup read: the active tab's panes with their bound PTY ids, once every pane has one. */
async function waitForBoundPanes(page: Page, count: number): Promise<BoundPane[]> {
  await waitForPaneCount(page, count, 30_000)
  let panes: BoundPane[] = []
  await expect
    .poll(
      async () => {
        panes = await page.evaluate(() => {
          const state = window.__store!.getState()
          const tabId = state.activeTabId
          const manager = tabId ? window.__paneManagers?.get(tabId) : undefined
          const bound = tabId ? state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId : undefined
          return (manager?.getPanes() ?? []).map((pane) => {
            const leafId = pane.leafId
            return { leafId, ptyId: bound?.[leafId] ?? '' }
          })
        })
        return panes.length === count && panes.every((pane) => pane.ptyId !== '')
      },
      { timeout: 30_000, message: 'A pane never bound its PTY' }
    )
    .toBe(true)
  return panes
}

/** Closes the focused pane through the user's chord, confirming the stop prompt if one appears. */
async function closeFocusedPaneWithChord(page: Page, panesBefore: number): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  const confirm = page.getByRole('button', { name: 'Stop and Close' })
  await expect
    .poll(
      async () => {
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.click()
        }
        return page.locator('.pane[data-leaf-id]:visible').count()
      },
      { timeout: 10_000, intervals: [50] }
    )
    .toBe(panesBefore - 1)
}

/** Waits until every listed pane's own buffer shows its marker (per pane, not just the active one). */
async function waitForPaneMarkers(page: Page, leafIds: string[]): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((leafIds) => {
          const state = window.__store!.getState()
          const manager = state.activeTabId
            ? window.__paneManagers?.get(state.activeTabId)
            : undefined
          const textByLeaf = new Map<string, string>(
            (manager?.getPanes() ?? []).map((pane) => [
              pane.leafId,
              pane.serializeAddon?.serialize?.() ?? ''
            ])
          )
          return leafIds.every((leafId) =>
            (textByLeaf.get(leafId) ?? '').includes(`KEEP_${leafId.slice(0, 8)}`)
          )
        }, leafIds),
      { timeout: 15_000, message: 'A pane lost its scrollback marker' }
    )
    .toBe(true)
}

async function listHostPtyIds(userDataDir: string, worktreeId: string): Promise<string[]> {
  const client = new RuntimeClient(userDataDir, 30_000)
  const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${worktreeId}`
  })
  return listed.result.terminals.map((terminal) => terminal.ptyId ?? '')
}

test('a pane closed right before quit does not come back after relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    const { worktreeId } = await bootstrapFirstLaunch(first.page, repoPath)
    await waitForBoundPanes(first.page, 1)
    await splitActiveTerminalPane(first.page, 'vertical')
    await waitForBoundPanes(first.page, 2)
    await splitActiveTerminalPane(first.page, 'horizontal')
    const three = await waitForBoundPanes(first.page, 3)
    for (const pane of three) {
      await sendToTerminal(first.page, pane.ptyId, `echo KEEP_${pane.leafId.slice(0, 8)}\r`)
    }
    await waitForPaneMarkers(
      first.page,
      three.map((pane) => pane.leafId)
    )

    await closeFocusedPaneWithChord(first.page, 3)
    const kept = await waitForBoundPanes(first.page, 2)
    const closed = three.find((pane) => !kept.some((k) => k.leafId === pane.leafId))
    expect(closed).toBeDefined()
    // Quit at once: the daemon is still inside the closed shell's kill grace.
    await session.close(app)
    app = null

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await expect.poll(() => getActiveWorktreeId(second.page), { timeout: 10_000 }).toBe(worktreeId)
    await ensureTerminalVisible(second.page)
    await waitForActiveTerminalManager(second.page, 30_000)
    await waitForBoundPanes(second.page, 2)
    // Why a settle window: the resurrection arrived as a late adopted tab after the kill finished.
    await second.page.waitForTimeout(4_000)

    await expect(second.page.locator(SORTABLE_TAB)).toHaveCount(1)
    await expect(second.page.locator('.pane[data-leaf-id]:visible')).toHaveCount(2)
    await waitForPaneMarkers(
      second.page,
      kept.map((pane) => pane.leafId)
    )
    const hostPtyIds = await listHostPtyIds(session.userDataDir, worktreeId)
    expect(hostPtyIds).not.toContain(closed!.ptyId)
    expect(hostPtyIds.toSorted()).toEqual(kept.map((pane) => pane.ptyId).toSorted())
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
