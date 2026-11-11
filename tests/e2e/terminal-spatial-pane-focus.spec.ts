// Mod+Alt+Arrow moves focus to the split terminal pane on that side; at the layout edge Left/Right
// fall back to worktree history. Keys go through the real input path, so main's interception runs.

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { worktreeRow } from './worktree-row-locators'

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

// Why: corners come from rendered rects, so the test follows the screen rather than split order.
async function paneIdsByCorner(page: Page, tabId: string): Promise<Record<Corner, number>> {
  return page.evaluate((tabId) => {
    const panes = window.__paneManagers?.get(tabId)?.getPanes() ?? []
    const rects = panes.map((p) => ({ id: p.id, r: p.container.getBoundingClientRect() }))
    const minX = Math.min(...rects.map((x) => x.r.left))
    const minY = Math.min(...rects.map((x) => x.r.top))
    const at = (top: boolean, left: boolean): number =>
      rects.find(
        (x) => Math.abs(x.r.top - minY) < 4 === top && Math.abs(x.r.left - minX) < 4 === left
      )?.id ?? -1
    return {
      'top-left': at(true, true),
      'top-right': at(true, false),
      'bottom-left': at(false, true),
      'bottom-right': at(false, false)
    }
  }, tabId)
}

// Reads keyboard focus from the DOM: the pane whose container holds document.activeElement.
async function focusedPaneId(page: Page, tabId: string): Promise<number | null> {
  return page.evaluate((tabId) => {
    const panes = window.__paneManagers?.get(tabId)?.getPanes() ?? []
    return panes.find((p) => p.container.contains(document.activeElement))?.id ?? null
  }, tabId)
}

async function focusPane(page: Page, tabId: string, paneId: number): Promise<void> {
  await page.evaluate(
    ({ tabId, paneId }) =>
      window.__paneManagers?.get(tabId)?.setActivePane(paneId, { focus: true }),
    { tabId, paneId }
  )
}

// Seed in production order (setActiveWorktree, then recordWorktreeVisit), as the back/forward spec does.
async function seedHistory(page: Page, worktreeIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.setState({ worktreeNavHistory: [], worktreeNavHistoryIndex: -1 })
    for (const id of ids) {
      store.getState().setActiveWorktree(id)
      store.getState().recordWorktreeVisit(id)
    }
  }, worktreeIds)
}

// Why: a pane focused before its PTY binding lands is redirected to a bound pane, so every split
// waits for leaf-keyed PTY bindings rather than just the pane count.
async function splitIntoGrid(
  page: Page
): Promise<{ tabId: string; corners: Record<Corner, number> }> {
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  await splitActiveTerminalPane(page, 'vertical')
  await waitForPaneIdentitySnapshot(page, 2)
  await splitActiveTerminalPane(page, 'horizontal')
  const three = await waitForPaneIdentitySnapshot(page, 3)
  await focusPane(page, three.tabId, three.panes[0].numericPaneId)
  await splitActiveTerminalPane(page, 'horizontal')
  const four = await waitForPaneIdentitySnapshot(page, 4)
  const corners = await paneIdsByCorner(page, four.tabId)
  expect(Object.values(corners).sort()).toEqual(four.panes.map((p) => p.numericPaneId).sort())
  return { tabId: four.tabId, corners }
}

test.describe('terminal spatial pane focus', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('Mod+Alt+Arrow walks a 2x2 split by screen position and does not wrap', async ({
    orcaPage
  }) => {
    const { tabId, corners } = await splitIntoGrid(orcaPage)
    await focusPane(orcaPage, tabId, corners['top-left'])
    await expect.poll(() => focusedPaneId(orcaPage, tabId)).toBe(corners['top-left'])

    const walk: [string, Corner][] = [
      ['ArrowRight', 'top-right'],
      ['ArrowDown', 'bottom-right'],
      ['ArrowLeft', 'bottom-left'],
      ['ArrowUp', 'top-left'],
      // Top edge: Up has no history fallback, so focus stays put instead of wrapping.
      ['ArrowUp', 'top-left']
    ]
    for (const [key, corner] of walk) {
      await orcaPage.keyboard.press(`${mod}+Alt+${key}`)
      await expect
        .poll(() => focusedPaneId(orcaPage, tabId), { message: `${key} should focus ${corner}` })
        .toBe(corners[corner])
    }
  })

  test('Mod+Alt+Left moves between panes inside the layout and runs history at its edge', async ({
    orcaPage
  }) => {
    const worktreeIds = await getAllWorktreeIds(orcaPage)
    test.skip(worktreeIds.length < 2, 'Need at least two worktrees to exercise history fallback')
    const [primaryId, secondaryId] = worktreeIds
    await seedHistory(orcaPage, [primaryId, secondaryId])

    const { tabId, corners } = await splitIntoGrid(orcaPage)
    await focusPane(orcaPage, tabId, corners['top-right'])
    await expect.poll(() => focusedPaneId(orcaPage, tabId)).toBe(corners['top-right'])

    // Inside the layout main yields the chord, so focus moves and history does not run.
    await orcaPage.keyboard.press(`${mod}+Alt+ArrowLeft`)
    await expect.poll(() => focusedPaneId(orcaPage, tabId)).toBe(corners['top-left'])
    expect(await getActiveWorktreeId(orcaPage)).toBe(secondaryId)
    await expect(worktreeRow(orcaPage, secondaryId)).toHaveAttribute('aria-current', 'page')

    // At the left edge there is no pane to move to, so the chord goes back in worktree history.
    await orcaPage.keyboard.press(`${mod}+Alt+ArrowLeft`)
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), { message: 'edge Left did not navigate back' })
      .toBe(primaryId)
    await expect(worktreeRow(orcaPage, primaryId)).toHaveAttribute('aria-current', 'page')
  })
})
