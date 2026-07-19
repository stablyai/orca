/**
 * Side-by-side workspaces (experimentalSideBySideWorkspaces).
 *
 * Covers Phase 1 of the split-view feature:
 *   - "Open to the Side" from the worktree context menu opens a second visible
 *     pane instead of replacing the current view.
 *   - Both panes render their inline tab strips at once.
 *   - Clicking the non-focused pane promotes it to activeWorktreeId without
 *     hiding the other pane (focus-follows-click).
 *   - A workspace divider renders between the panes.
 */

import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  getActiveWorktreeId,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

type SplitLeafIds = string[]

async function enableSideBySideWorkspaces(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ experimentalSideBySideWorkspaces: true })
    // Why: E2E profiles use production defaults; the store must see the flag
    // immediately without a relaunch.
    window.__store?.setState({ settings })
  })
}

async function getSplitLeafIds(page: Page): Promise<SplitLeafIds> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }
    type PaneNode =
      | { type: 'pane'; worktreeId: string }
      | { type: 'split'; first: PaneNode; second: PaneNode }
    const layout = (store.getState() as { workspaceSplitLayout?: PaneNode | null })
      .workspaceSplitLayout
    if (!layout) {
      return []
    }
    const leaves: string[] = []
    const walk = (node: PaneNode): void => {
      if (node.type === 'pane') {
        leaves.push(node.worktreeId)
        return
      }
      walk(node.first)
      walk(node.second)
    }
    walk(layout)
    return leaves
  })
}

async function createSecondWorktree(page: Page, name: string): Promise<string> {
  return page.evaluate(async (worktreeName) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    const activeWorktreeId = state.activeWorktreeId
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === activeWorktreeId)
    if (!activeWorktree) {
      throw new Error('active worktree not found')
    }
    const result = await state.createWorktree(activeWorktree.repoId, worktreeName)
    await state.fetchWorktrees(activeWorktree.repoId)
    return result.worktree.id
  }, name)
}

test.describe('side-by-side workspaces', () => {
  test('open to the side shows two live panes with focus-follows-click', async ({
    orcaPage: page
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(page)
    const primaryId = await waitForActiveWorktree(page)
    await enableSideBySideWorkspaces(page)

    const sideId = await createSecondWorktree(page, `e2e-side-pane-${Date.now()}`)
    // Creation does not activate; the primary worktree must still be focused.
    expect(await getActiveWorktreeId(page)).toBe(primaryId)

    // Open the second worktree to the side via the real context-menu path.
    await worktreeRow(page, sideId).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open to the Side' }).click()

    // The split opens with primary on the left, side pane on the right, and
    // focus moves to the newly opened pane.
    await expect.poll(() => getSplitLeafIds(page), { timeout: 30_000 }).toEqual([primaryId, sideId])
    await expect.poll(() => getActiveWorktreeId(page)).toBe(sideId)

    // Both panes render their inline tab strips simultaneously.
    const stripFor = (worktreeId: string): ReturnType<Page['locator']> =>
      page.locator(`[data-tab-group-strip-id][data-worktree-id=${JSON.stringify(worktreeId)}]`)
    await expect(stripFor(primaryId).first()).toBeVisible({ timeout: 30_000 })
    await expect(stripFor(sideId).first()).toBeVisible({ timeout: 30_000 })

    // Exactly one workspace divider (no tab-group splits exist yet).
    await expect(page.locator('.tab-group-split-resize-handle')).toHaveCount(1)

    // Clicking the primary pane's strip promotes it to focused without
    // collapsing the split.
    await stripFor(primaryId).first().click()
    await expect.poll(() => getActiveWorktreeId(page)).toBe(primaryId)
    expect(await getSplitLeafIds(page)).toEqual([primaryId, sideId])
    await expect(stripFor(sideId).first()).toBeVisible()

    // The split layout persists into the session payload on the production
    // shutdown flush, so a restart can restore both panes.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const session = await window.api.session.get()
            const layout = (session as { workspaceSplitLayoutOnShutdown?: { type: string } | null })
              .workspaceSplitLayoutOnShutdown
            return layout?.type ?? null
          }),
        { timeout: 10_000, message: 'split layout was not persisted on shutdown flush' }
      )
      .toBe('split')

    // Splits are associations: activating an unrelated worktree shows it
    // alone, and activating a member restores the split.
    const unrelatedId = await createSecondWorktree(page, `e2e-unrelated-${Date.now()}`)
    await switchToWorktree(page, unrelatedId)
    await expect.poll(() => getSplitLeafIds(page)).toEqual([])
    await expect.poll(() => getActiveWorktreeId(page)).toBe(unrelatedId)
    await switchToWorktree(page, primaryId)
    await expect.poll(() => getSplitLeafIds(page)).toEqual([primaryId, sideId])

    // Maximize shows one pane full-width with the split intact underneath;
    // restore brings the grid back.
    await page.locator(`[data-workspace-pane-maximize=${JSON.stringify(sideId)}]`).click()
    await expect(stripFor(sideId).first()).toBeVisible()
    await expect(stripFor(primaryId).first()).not.toBeVisible()
    expect(await getSplitLeafIds(page)).toEqual([primaryId, sideId])
    await expect.poll(() => getActiveWorktreeId(page)).toBe(sideId)
    await page.locator(`[data-workspace-pane-restore=${JSON.stringify(sideId)}]`).click()
    await expect(stripFor(primaryId).first()).toBeVisible()
    await expect(stripFor(sideId).first()).toBeVisible()

    // The pane's ✕ chip sends it back: the split dissolves, focus stays on
    // the surviving pane, and the pair no longer reopens together.
    await page.locator(`[data-workspace-pane-close=${JSON.stringify(sideId)}]`).click()
    await expect.poll(() => getSplitLeafIds(page)).toEqual([])
    expect(await getActiveWorktreeId(page)).toBe(primaryId)
    await switchToWorktree(page, sideId)
    await switchToWorktree(page, primaryId)
    await expect.poll(() => getSplitLeafIds(page)).toEqual([])
  })

  test('dragging a project card into the workspace body opens a split', async ({
    orcaPage: page
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(page)
    const primaryId = await waitForActiveWorktree(page)
    await enableSideBySideWorkspaces(page)
    const sideId = await createSecondWorktree(page, `e2e-drag-pane-${Date.now()}`)

    const row = worktreeRow(page, sideId)
    const rowBox = await row.boundingBox()
    const bodyBox = await page.locator('[data-workspace-split-drop-root]').boundingBox()
    if (!rowBox || !bodyBox) {
      throw new Error('missing drag geometry')
    }
    // Drag the card from the sidebar onto the right quarter of the workspace
    // body (edge zone → split right). Multiple small moves keep the custom
    // pointer-drag's activation threshold and frame hit-testing realistic.
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await page.mouse.down()
    const targetX = bodyBox.x + bodyBox.width * 0.9
    const targetY = bodyBox.y + bodyBox.height * 0.5
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        rowBox.x + ((targetX - rowBox.x) * step) / 8,
        rowBox.y + ((targetY - rowBox.y) * step) / 8
      )
    }
    await page.mouse.up()

    await expect.poll(() => getSplitLeafIds(page), { timeout: 30_000 }).toEqual([primaryId, sideId])
    await expect.poll(() => getActiveWorktreeId(page)).toBe(sideId)
  })

  test('flag off keeps the context menu free of Open to the Side', async ({ orcaPage: page }) => {
    await waitForSessionReady(page)
    const primaryId = await waitForActiveWorktree(page)
    await worktreeRow(page, primaryId).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open to the Side' })).toHaveCount(0)
  })
})
