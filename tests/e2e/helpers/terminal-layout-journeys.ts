/** Terminal layout journeys shared by the layout parity scenarios and the layout oracle. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  countVisibleTerminalPanes,
  focusActiveTerminalInput,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './terminal'
import { ensureTerminalVisible, waitForSessionReady } from './store'
import { SORTABLE_TAB } from './terminal-tab-menu'

export type FolderWorkspaceSetup = {
  worktreeId: string
  pathLabels: Record<string, string>
  cleanup: () => void
}

/** Human pacing: the next gesture waits until every pane of the active tab has a bound PTY. */
export async function waitForBoundPanes(page: Page, count: number): Promise<void> {
  await waitForPaneCount(page, count, 30_000)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store!.getState()
          const manager = state.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
          const bound = state.activeTabId
            ? state.terminalLayoutsByTabId[state.activeTabId]?.ptyIdsByLeafId
            : undefined
          return (manager?.getPanes() ?? []).every((pane) => {
            const leafId = manager!.getLeafId(pane.id)
            return leafId !== null && Boolean(bound?.[leafId])
          })
        }),
      { timeout: 30_000, message: 'A pane never bound its PTY' }
    )
    .toBe(true)
}

export async function addFolderWorkspace(page: Page): Promise<FolderWorkspaceSetup> {
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-parity-folder-')))
  const cleanup = (): void => rmSync(folderPath, { recursive: true, force: true })
  const repoId = await page.evaluate(async (folder) => {
    const result = await window.api.repos.add({ path: folder, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, folderPath)
  await waitForSessionReady(page)
  let worktreeId: string | null = null
  await expect
    .poll(async () => {
      worktreeId = await page.evaluate(async (id) => {
        const store = window.__store!
        await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
        await store.getState().fetchWorktrees(id)
        const worktree = store.getState().worktreesByRepo[id]?.[0]
        if (worktree) {
          store.getState().setActiveWorktree(worktree.id)
        }
        return worktree?.id ?? null
      }, repoId)
      return worktreeId
    })
    .not.toBeNull()
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  return { worktreeId: worktreeId!, pathLabels: { [folderPath]: '<folder>' }, cleanup }
}

/**
 * The user's close-pane chord, so the close reaches main through the real commit path; driving
 * PaneManager.closePane directly leaves main to learn of it from the PTY exit, which races quit.
 */
export async function closeActivePaneFromKeyboard(page: Page, paneCount: number): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  // A fresh shell can still read as busy, which asks before stopping it.
  const confirm = page.getByRole('button', { name: 'Stop and Close' })
  await expect
    .poll(
      async () => {
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.click()
        }
        return countVisibleTerminalPanes(page)
      },
      { timeout: 10_000, intervals: [50] }
    )
    .toBe(paneCount - 1)
}

/** A real pointer drag of a pane's handle onto the tab strip, past the last tab, as a user drags a pane out. */
export async function dragPaneOutToTabStrip(
  page: Page,
  worktreeId: string,
  leafId: string
): Promise<void> {
  const handle = page.locator(`.pane[data-leaf-id="${leafId}"] .pane-drag-handle`)
  const strip = page.locator(`[data-tab-group-strip-id][data-worktree-id="${worktreeId}"]`).first()
  const lastTab = strip.locator(SORTABLE_TAB).last()
  const handleBox = await handle.boundingBox()
  const stripBox = await strip.boundingBox()
  const lastTabBox = await lastTab.boundingBox()
  if (!handleBox || !stripBox || !lastTabBox) {
    throw new Error('Pane drag handle or tab strip is not laid out')
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(
    Math.min(lastTabBox.x + lastTabBox.width + 24, stripBox.x + stripBox.width - 4),
    stripBox.y + stripBox.height / 2,
    { steps: 20 }
  )
  await page.mouse.up()
}

export type TabDropSide = 'left' | 'right' | 'top' | 'bottom'

/** Where a pane edge drop lands: inside the group's interior (the panel minus the 20% new-column band), near `side` of the pane. */
async function readPaneEdgeDropPoint(
  page: Page,
  args: { tabId: string; leafId: string; side: TabDropSide }
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(({ tabId, leafId, side }) => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const groupId = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.entityId === tabId
    )?.groupId
    const body = document.querySelector(
      `[data-tab-group-body-id="${groupId}"][data-worktree-id="${worktreeId}"]`
    )
    const pane = document.querySelector(
      `[data-terminal-tab-id="${tabId}"] .pane[data-leaf-id="${leafId}"]`
    )
    if (!body?.parentElement || !pane) {
      return null
    }
    const panel = body.parentElement.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()
    const paneRect = pane.getBoundingClientRect()
    const left = Math.max(paneRect.left, panel.left + panel.width * 0.2)
    const right = Math.min(paneRect.right, panel.right - panel.width * 0.2)
    const top = Math.max(paneRect.top, bodyRect.top + bodyRect.height * 0.2)
    const bottom = Math.min(paneRect.bottom, bodyRect.bottom - bodyRect.height * 0.2)
    const inset = 0.08
    return {
      x:
        side === 'left'
          ? left + (right - left) * inset
          : side === 'right'
            ? right - (right - left) * inset
            : (left + right) / 2,
      y:
        side === 'top'
          ? top + (bottom - top) * inset
          : side === 'bottom'
            ? bottom - (bottom - top) * inset
            : (top + bottom) / 2
    }
  }, args)
  if (!point) {
    throw new Error(`Pane ${args.leafId} of tab ${args.tabId} is not laid out`)
  }
  return point
}

/**
 * A real pointer drag of a tab onto the edge of a pane inside another tab: over that tab's strip
 * entry first (which shows it), then to the edge. Waits for the "Join tab" overlay before the drop.
 */
export async function dragTabIntoPane(
  page: Page,
  args: { sourceTabId: string; targetTabId: string; leafId: string; side: TabDropSide }
): Promise<void> {
  const source = await page
    .locator(`${SORTABLE_TAB}[data-tab-id="${args.sourceTabId}"]`)
    .boundingBox()
  const target = await page
    .locator(`${SORTABLE_TAB}[data-tab-id="${args.targetTabId}"]`)
    .boundingBox()
  if (!source || !target) {
    throw new Error('Source or target tab is not laid out')
  }
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  const point = await readPaneEdgeDropPoint(page, {
    tabId: args.targetTabId,
    leafId: args.leafId,
    side: args.side
  })
  await page.mouse.move(point.x, point.y, { steps: 20 })
  await expect(page.locator('[data-leaf-drop-overlay]')).toContainText('Join tab')
  await page.mouse.up()
}
