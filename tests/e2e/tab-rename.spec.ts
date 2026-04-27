/**
 * E2E tests for inline tab renaming (double-click a tab to rename).
 *
 * User Prompt:
 * - double-click a tab to rename it inline
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getWorktreeTabs,
  ensureTerminalVisible
} from './helpers/store'

test.describe('Tab Rename (Inline)', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    // Why: clear any custom titles left by a previous test (the Electron app
    // persists across tests in the worker) so tab locators key off the default
    // title, not a stale rename like "My Custom Title".
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      for (const tabs of Object.values(state.tabsByWorktree)) {
        for (const tab of tabs) {
          if (tab.customTitle != null) {
            state.setTabCustomTitle(tab.id, null)
          }
        }
      }
    })
  })

  async function getActiveTabTitle(
    page: Parameters<typeof getActiveTabId>[0],
    worktreeId: string
  ): Promise<string> {
    const activeId = await getActiveTabId(page)
    expect(activeId).not.toBeNull()
    const tabs = await getWorktreeTabs(page, worktreeId)
    const tab = tabs.find((entry) => entry.id === activeId)
    expect(tab).toBeDefined()
    // Why: mirror what the UI renders (customTitle ?? title) so locators that
    // key off the tab's visible text match what's actually on screen.
    return tab!.title ?? ''
  }

  function tabLocatorByTitle(
    page: Parameters<typeof getActiveTabId>[0],
    title: string
  ): ReturnType<Parameters<typeof getActiveTabId>[0]['locator']> {
    // Why: backslash first so the backslashes we introduce when escaping the
    // double-quote aren't themselves re-escaped; both chars are CSS-selector
    // metacharacters inside a double-quoted attribute value.
    const escaped = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return page.locator(`[data-testid="sortable-tab"][data-tab-title="${escaped}"]`).first()
  }

  async function getActiveCustomTitle(
    page: Parameters<typeof getActiveTabId>[0],
    worktreeId: string
  ): Promise<string | null> {
    return page.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return null
      }

      const state = store.getState()
      const activeId = state.activeTabIdByWorktree[targetWorktreeId] ?? state.activeTabId
      const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find((t) => t.id === activeId)
      return tab?.customTitle ?? null
    }, worktreeId)
  }

  test('double-clicking a tab opens an inline rename input and Enter commits', async ({
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)
    expect(originalTitle.length).toBeGreaterThan(0)

    const tabLocator = tabLocatorByTitle(orcaPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('My Custom Title')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe('My Custom Title')
    await expect(renameInput).toBeHidden()
    await expect(tabLocatorByTitle(orcaPage, 'My Custom Title')).toBeVisible()
  })

  test('Escape during inline rename discards the edit', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)

    const tabLocator = tabLocatorByTitle(orcaPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Should Be Discarded')
    await renameInput.press('Escape')

    await expect(renameInput).toBeHidden()
    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('renaming to an empty string resets the tab to its default title', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Why: seed a custom title directly via the store so this test asserts the
    // "empty string → reset" behavior independently from the double-click flow.
    await orcaPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      const activeId = state.activeTabIdByWorktree[targetWorktreeId] ?? state.activeTabId
      if (activeId) {
        state.setTabCustomTitle(activeId, 'Seeded Custom')
      }
    }, worktreeId)

    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe('Seeded Custom')

    const tabLocator = tabLocatorByTitle(orcaPage, 'Seeded Custom')
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: 'Rename tab Seeded Custom',
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('clicking away (blur) commits the rename', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Why: need a second tab so we have something to click that isn't the
    // rename input itself. Seed both with known titles so we can locate them.
    await orcaPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = state.tabsByWorktree[targetWorktreeId] ?? []
      if (existing.length < 2) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)

    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(2)

    const tabs = await getWorktreeTabs(orcaPage, worktreeId)
    const activeId = await getActiveTabId(orcaPage)
    const activeTab = tabs.find((t) => t.id === activeId)!
    const otherTab = tabs.find((t) => t.id !== activeId)!

    const tabLocator = tabLocatorByTitle(orcaPage, activeTab.title!)
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${activeTab.title}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Committed By Blur')
    // Why: clicking the other tab triggers blur on the input, which should
    // run commitRename and save the typed title before the focus shifts.
    await tabLocatorByTitle(orcaPage, otherTab.title!).click()

    await expect(renameInput).toBeHidden()
    await expect(tabLocatorByTitle(orcaPage, 'Committed By Blur')).toBeVisible()
    expect(
      await orcaPage.evaluate(
        ({ targetWorktreeId, targetTabId }) => {
          const store = window.__store
          const state = store!.getState()
          const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find(
            (t) => t.id === targetTabId
          )
          return tab?.customTitle ?? null
        },
        { targetWorktreeId: worktreeId, targetTabId: activeTab.id }
      )
    ).toBe('Committed By Blur')
  })

  test('right-clicking during inline rename commits and opens context menu', async ({
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)

    const tabLocator = tabLocatorByTitle(orcaPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Committed By Right Click')
    // Why: right-clicking the tab blurs the input (commitRename runs) and
    // opens the context menu. We assert the rename was saved; the menu
    // assertion is intentionally light because the menu markup is shared
    // with other specs.
    await tabLocator.click({ button: 'right' })

    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe('Committed By Right Click')
    await expect(renameInput).toBeHidden()
  })

  test('rename input stays at a usable width when many tabs are open', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Why: create enough terminal tabs that flex space runs out. 15 is well
    // above the threshold at which the pre-fix input collapsed, and it keeps
    // the test fast. The width fix pins the input to 72px (matching the
    // slimmer tab title box), so even saturated, it should stay near that
    // size — we assert ≥60px to allow a bit of slack for fonts/padding/
    // containers differing between environments. The meaningful guarantee is
    // that the input does not collapse to ~0 when flex space is saturated.
    await orcaPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }
      const state = store.getState()
      const existing = (state.tabsByWorktree[targetWorktreeId] ?? []).length
      for (let i = existing; i < 15; i++) {
        state.createTab(targetWorktreeId)
      }
    }, worktreeId)

    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(15)

    const activeTitle = await getActiveTabTitle(orcaPage, worktreeId)
    const tabLocator = tabLocatorByTitle(orcaPage, activeTitle)
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${activeTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    const box = await renameInput.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(60)
  })

  test('middle-clicking inside the rename input does not close the tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabsBefore = (await getWorktreeTabs(orcaPage, worktreeId)).length
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)

    const tabLocator = tabLocatorByTitle(orcaPage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    // Why: the outer tab's middle-click handler closes the tab. The rename
    // input stops propagation + preventDefaults middle-click so the tab
    // isn't closed while the user is editing.
    await renameInput.click({ button: 'middle' })

    // The tab must still exist — no regression where editing-then-middle-click
    // accidentally closes the tab out from under the input.
    expect((await getWorktreeTabs(orcaPage, worktreeId)).length).toBe(tabsBefore)
  })
})
