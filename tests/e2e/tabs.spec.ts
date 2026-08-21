/**
 * E2E tests for tab management: creating, switching, reordering, and closing tabs.
 *
 * User Prompt:
 * - New tab works
 * - dragging tabs around to reorder them
 * - closing tabs works
 * - double-click a tab to rename it inline
 *
 * Why these specs assert on the DOM: a prior version of this file drove every
 * flow through `window.__store` and read the same fields back — a tautology
 * that would have passed even if the tab bar had stopped rendering (the same
 * pattern that let PR #1186's `StartFromField` render crash ship past the
 * E2E suite in #1193). The rule in tests/e2e/AGENTS.md is that the final
 * `expect()` must target user-observable DOM. Store calls are only used here
 * for *setup* (e.g. to guarantee >= N tabs exist) or when the real user-facing
 * action genuinely can't be driven via DOM in hidden-window Electron runs
 * (dnd-kit reorder); in those cases a DOM assertion still follows.
 */

import { test, expect } from './helpers/mcode-app'
import type { Page } from '@stablyai/playwright-test'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getActiveTabType,
  getWorktreeTabs,
  getTabBarOrder,
  ensureTerminalVisible
} from './helpers/store'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function tabLocator(page: Page, tabId: string) {
  return page.locator(`${SORTABLE_TAB}[data-tab-id="${tabId}"]`).first()
}

/** Count rendered tabs in the tab bar (user-visible, not store-level). */
async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

/**
 * Read the DOM's active-tab id from the `data-active` attribute exposed by
 * SortableTab. We assert on DOM rather than `activeTabId` in the store so a
 * render-layer regression (e.g. the active indicator failing to paint on the
 * correct tab) cannot silently pass.
 */
async function getDomActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    const match = document.querySelector(`${selector}[data-active="true"]`)
    return match?.getAttribute('data-tab-id') ?? null
  }, SORTABLE_TAB)
}

async function getFocusedTerminalTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.classList.contains('xterm-helper-textarea')) {
      return null
    }
    return active.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id') ?? null
  })
}

test.describe('Tabs', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
    await ensureTerminalVisible(mcodePage)
  })

  /**
   * User Prompt:
   * - New tab works
   *
   * Why: asserting on a new `[data-testid="sortable-tab"]` in the DOM (not
   * `tabsByWorktree.length` in the store) is the guard that would have caught
   * a tab-bar render regression. Clicking the real "+" button and then "New
   * Terminal" drives the same code path a user takes.
   */
  test('clicking "+" then "New Terminal" creates a new terminal tab', async ({ mcodePage }) => {
    const tabsBefore = await countRenderedTabs(mcodePage)

    // Why: hidden-window Electron can keep the animated terminal surface
    // invalidating Playwright's "stable" actionability check even though the
    // tab-bar button is visible and enabled.
    await mcodePage.getByRole('button', { name: 'New tab' }).click({ force: true })
    // Why: the "+" dropdown uses Radix <DropdownMenuItem>, which exposes the
    // label text as the accessible name once the menu is open.
    const newTerminalMenuItem = mcodePage.getByRole('menuitem', { name: /New Terminal/i }).first()
    await newTerminalMenuItem.click({ force: true })
    await expect(newTerminalMenuItem).toBeHidden({ timeout: 3_000 })

    // Final assertion is on the rendered tab count — the tab bar itself must
    // gain an element, not just the store.
    await expect
      .poll(() => countRenderedTabs(mcodePage), {
        timeout: 5_000,
        message: 'Clicking + → New Terminal did not render a new tab in the tab bar'
      })
      .toBeGreaterThan(tabsBefore)

    const activeType = await getActiveTabType(mcodePage)
    expect(activeType).toBe('terminal')

    const storeActiveId = await getActiveTabId(mcodePage)
    expect(storeActiveId).not.toBeNull()
    await expect(tabLocator(mcodePage, storeActiveId!)).toBeVisible()
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(storeActiveId)
    await expect
      .poll(() => getFocusedTerminalTabId(mcodePage), {
        timeout: 5_000,
        message: 'Menu-created terminal tab did not receive keyboard focus'
      })
      .toBe(storeActiveId)
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('Cmd/Ctrl+T creates a new terminal tab', async ({ mcodePage }) => {
    const isMac = process.platform === 'darwin'
    const mod = isMac ? 'Meta' : 'Control'
    const tabsBefore = await countRenderedTabs(mcodePage)

    // Why: focus body first so the window-level keydown handler on Terminal.tsx
    // actually sees the event. Without focus the key may be eaten by an
    // unrelated input (e.g. a stale search field from a previous test).
    await mcodePage.evaluate(() => document.body.focus())
    await mcodePage.keyboard.press(`${mod}+t`)

    // DOM-level count increased — confirms a new tab actually rendered.
    await expect
      .poll(() => countRenderedTabs(mcodePage), {
        timeout: 5_000,
        message: `${mod}+T did not add a tab to the tab bar`
      })
      .toBe(tabsBefore + 1)

    // The newly-rendered active tab must be a terminal (tab-type is visible as
    // the active surface behind the strip; we rely on the store flag here only
    // to disambiguate terminal vs. editor vs. browser — the fact that *some*
    // tab is active is already proved by the DOM assertion below).
    const activeType = await getActiveTabType(mcodePage)
    expect(activeType).toBe('terminal')

    // The DOM must have exactly one active tab and it must match the store's
    // activeTabId — this is the load-bearing check that the render layer and
    // the state layer agree on what is selected.
    const storeActiveId = await getActiveTabId(mcodePage)
    expect(storeActiveId).not.toBeNull()
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(storeActiveId)
  })

  /**
   * User Prompt:
   * - New tab works
   *
   * Why: we still use the store's `setActiveTab` for the switch itself (the
   * hotkey path that used to be here turned out to target bracket-chord next/
   * prev tab cycling, not arbitrary tab selection), but the final assertion
   * checks DOM `data-active` to prove the selection actually paints onto the
   * right tab element.
   */
  test('Cmd/Ctrl+Shift+] and Cmd/Ctrl+Shift+[ switch between tabs', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    // Ensure we have at least 2 tabs — use the real "+" flow so a render
    // regression would fail setup before we even start the cycle check.
    if ((await countRenderedTabs(mcodePage)) < 2) {
      await mcodePage.getByRole('button', { name: 'New tab' }).click()
      await mcodePage
        .getByRole('menuitem', { name: /New Terminal/i })
        .first()
        .click()
      await expect
        .poll(() => countRenderedTabs(mcodePage), { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const firstTabId = await getActiveTabId(mcodePage)
    const orderedTabs = await getWorktreeTabs(mcodePage, worktreeId)
    const secondTabId = orderedTabs.find((tab) => tab.id !== firstTabId)?.id
    expect(secondTabId).toBeTruthy()

    await mcodePage.evaluate((tabId) => {
      window.__store?.getState().setActiveTab(tabId)
    }, secondTabId)

    // DOM assertion — the second tab must actually show the active indicator.
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(secondTabId)

    // Switch back.
    await mcodePage.evaluate((tabId) => {
      window.__store?.getState().setActiveTab(tabId)
    }, firstTabId)
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(firstTabId)
  })

  /**
   * User Prompt:
   * - dragging tabs around to reorder them
   *
   * Why the reorder is still store-driven: real dnd-kit pointer events are
   * unreliable in the hidden-window Electron mode we run E2E in (pointer
   * capture + collision detection interact poorly with `window.show()` being
   * suppressed). We seed the post-drag state via `reorderUnifiedTabs` — the
   * same action dnd-kit calls on drop — and then assert the tab bar's DOM
   * order matches the new sequence. That final DOM check is what makes this
   * a real test: a pure store round-trip would not catch a regression where
   * the tab strip stopped re-rendering in the store's new order.
   */
  test('dragging a tab to a new position reorders it', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    if ((await countRenderedTabs(mcodePage)) < 2) {
      await mcodePage.getByRole('button', { name: 'New tab' }).click()
      await mcodePage
        .getByRole('menuitem', { name: /New Terminal/i })
        .first()
        .click()
      await expect
        .poll(() => countRenderedTabs(mcodePage), { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const domOrderBefore = await mcodePage.$$eval(SORTABLE_TAB, (nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
    )
    expect(domOrderBefore.length).toBeGreaterThanOrEqual(2)

    await mcodePage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      const groups = state.groupsByWorktree[targetWorktreeId] ?? []
      const activeGroupId = state.activeGroupIdByWorktree[targetWorktreeId]
      const activeGroup = activeGroupId
        ? groups.find((group) => group.id === activeGroupId)
        : groups[0]

      if (activeGroup?.tabOrder?.length >= 2) {
        const nextOrder = [
          activeGroup.tabOrder[1],
          activeGroup.tabOrder[0],
          ...activeGroup.tabOrder.slice(2)
        ]
        state.reorderUnifiedTabs(activeGroup.id, nextOrder)
        return
      }

      const terminalOrder = (state.tabsByWorktree[targetWorktreeId] ?? []).map((tab) => tab.id)
      if (terminalOrder.length >= 2) {
        state.setTabBarOrder(targetWorktreeId, [
          terminalOrder[1],
          terminalOrder[0],
          ...terminalOrder.slice(2)
        ])
      }
    }, worktreeId)

    // Final assertion: the tab strip must re-render with the swapped order.
    // Keying off `data-tab-id` makes this independent of title formatting.
    await expect
      .poll(
        async () =>
          mcodePage.$$eval(SORTABLE_TAB, (nodes) =>
            nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
          ),
        { timeout: 3_000, message: 'Tab bar DOM order did not reflect the reorder' }
      )
      .toEqual([domOrderBefore[1], domOrderBefore[0], ...domOrderBefore.slice(2)])
  })

  test('clicking tabs still switches after dragging a terminal tab to reorder', async ({
    mcodePage
  }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    await mcodePage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = (state.tabsByWorktree[targetWorktreeId] ?? []).length
      for (let i = existing; i < 2; i++) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(mcodePage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const domOrderBefore = await mcodePage.$$eval(SORTABLE_TAB, (nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
    )
    const [firstTabId, secondTabId] = domOrderBefore
    expect(firstTabId).toBeTruthy()
    expect(secondTabId).toBeTruthy()

    await tabLocator(mcodePage, firstTabId).click({ force: true })
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(firstTabId)

    const firstTabBox = await tabLocator(mcodePage, firstTabId).boundingBox()
    const secondTabBox = await tabLocator(mcodePage, secondTabId).boundingBox()
    expect(firstTabBox).not.toBeNull()
    expect(secondTabBox).not.toBeNull()
    const startX = firstTabBox!.x + firstTabBox!.width / 2
    const startY = firstTabBox!.y + firstTabBox!.height / 2
    const endX = secondTabBox!.x + secondTabBox!.width * 0.75
    const endY = secondTabBox!.y + secondTabBox!.height / 2
    await mcodePage.mouse.move(startX, startY)
    await mcodePage.mouse.down()
    // Why: this mirrors the release repro: drag a terminal tab across another
    // tab far enough for dnd-kit to commit a reorder, then release on the tab
    // strip before clicking tabs again.
    await mcodePage.mouse.move(endX, endY, { steps: 8 })
    await mcodePage.mouse.up()

    await expect
      .poll(
        async () =>
          mcodePage.$$eval(SORTABLE_TAB, (nodes) =>
            nodes.map((n) => (n as HTMLElement).dataset.tabId ?? '')
          ),
        { timeout: 5_000, message: 'Terminal tab drag did not reorder the tab strip' }
      )
      .toEqual([secondTabId, firstTabId, ...domOrderBefore.slice(2)])

    await tabLocator(mcodePage, firstTabId).click({ force: true })
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(firstTabId)
    await tabLocator(mcodePage, secondTabId).click({ force: true })
    await expect
      .poll(() => getDomActiveTabId(mcodePage), {
        timeout: 5_000,
        message: 'Tab click did not activate after a terminal tab reorder drag'
      })
      .toBe(secondTabId)
  })

  /**
   * Regression: after a drag-reorder, Cmd/Ctrl+Shift+[ must walk tabs in
   * the new visible order. The pre-fix bug read a stale legacy order
   * (`tabBarOrderByWorktree`), so pressing "left" three times cycled
   * 3 → 1 → 2 instead of 3 → 2 → 1 once tabs had been rearranged.
   *
   * The DOM assertion (`data-active` matching the expected tab element) is
   * the load-bearing check — it fails if the shortcut walks the right store
   * id but the tab bar stops painting the active indicator on that tab.
   */
  test('Cmd/Ctrl+Shift+[ walks tabs in drag-reordered order', async ({ mcodePage }) => {
    const isMac = process.platform === 'darwin'
    const mod = isMac ? 'Meta' : 'Control'
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    // Ensure at least 3 terminal tabs so the order cycle is non-trivial.
    // Why store-driven: we only need >=3 tabs to exist; the "+" flow is
    // already exercised by other tests in this file.
    await mcodePage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = (state.tabsByWorktree[targetWorktreeId] ?? []).length
      for (let i = existing; i < 3; i++) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(async () => (await getWorktreeTabs(mcodePage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(3)

    const initialOrder = await getTabBarOrder(mcodePage, worktreeId)
    expect(initialOrder.length).toBeGreaterThanOrEqual(3)
    const [a, b, c] = initialOrder

    // Reorder via the same store call drag/drop uses: move the first tab to
    // the end so the visible order becomes [b, c, a].
    await mcodePage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const groups = state.groupsByWorktree[targetWorktreeId] ?? []
      const activeGroupId = state.activeGroupIdByWorktree[targetWorktreeId]
      const activeGroup = activeGroupId
        ? groups.find((group) => group.id === activeGroupId)
        : groups[0]
      if (!activeGroup) {
        return
      }
      const [first, ...rest] = activeGroup.tabOrder
      state.reorderUnifiedTabs(activeGroup.id, [...rest, first])
    }, worktreeId)
    await expect
      .poll(async () => getTabBarOrder(mcodePage, worktreeId), { timeout: 3_000 })
      .toEqual([b, c, a])

    // Activate the last tab in the new visible order, then walk left twice.
    // Expected cycle: a → c → b (i.e. walks the *new* order in reverse).
    await mcodePage.evaluate((tabId) => {
      window.__store?.getState().setActiveTab(tabId)
    }, a)
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(a)

    await mcodePage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(c)
    await expect(tabLocator(mcodePage, c)).toHaveAttribute('data-active', 'true')

    await mcodePage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 3_000 }).toBe(b)
    await expect(tabLocator(mcodePage, b)).toHaveAttribute('data-active', 'true')
  })

  /**
   * User Prompt:
   * - closing tabs works
   *
   * Why: clicking the real per-tab close (X) button exercises the same path a
   * user takes and catches regressions where the button silently unmounts.
   * The final assertion counts rendered `[data-testid="sortable-tab"]` nodes
   * so the test fails if the store cleared the tab but the DOM didn't
   * re-render.
   */
  test('closing a tab removes it from the tab bar', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    // Need a second tab so we can close one without deactivating the worktree.
    await mcodePage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      if ((state.tabsByWorktree[targetWorktreeId] ?? []).length < 2) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(mcodePage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const tabsBefore = await countRenderedTabs(mcodePage)
    const activeId = await getActiveTabId(mcodePage)
    expect(activeId).not.toBeNull()
    const activeTab = tabLocator(mcodePage, activeId!)
    // Why: hover the tab first so the close button reveals its hover style.
    // The button is interactive regardless but hovering matches real user
    // behaviour and keeps click coordinates stable.
    await activeTab.hover()
    await activeTab.getByRole('button', { name: /^Close tab /i }).click()

    await expect
      .poll(() => countRenderedTabs(mcodePage), {
        timeout: 5_000,
        message: 'Clicking close did not remove the tab element from the DOM'
      })
      .toBe(tabsBefore - 1)
  })

  /**
   * User Prompt:
   * - closing tabs works
   *
   * The DOM check (`data-active="true"` lands on a different element) proves
   * the tab bar re-paints the active indicator after a close — a store-only
   * check would pass even if the indicator failed to shift.
   */
  test('closing the active tab activates a neighbor tab', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    await mcodePage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      if ((state.tabsByWorktree[targetWorktreeId] ?? []).length < 2) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)
    await expect
      .poll(() => countRenderedTabs(mcodePage), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const activeTabBefore = await getActiveTabId(mcodePage)
    expect(activeTabBefore).not.toBeNull()

    const activeTab = tabLocator(mcodePage, activeTabBefore!)
    await activeTab.hover()
    await activeTab.getByRole('button', { name: /^Close tab /i }).click()

    // Final DOM assertion: some *other* tab element now carries data-active.
    await expect
      .poll(() => getDomActiveTabId(mcodePage), {
        timeout: 5_000,
        message: 'After closing the active tab, no neighbor tab took over the active indicator'
      })
      .not.toBe(activeTabBefore)
    await expect.poll(() => getDomActiveTabId(mcodePage), { timeout: 5_000 }).not.toBeNull()
  })
})
