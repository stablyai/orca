/**
 * E2E tests for inline tab renaming (double-click a tab to rename).
 *
 * User Prompt:
 * - double-click a tab to rename it inline
 */

import { test, expect } from './helpers/mcode-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getWorktreeTabs,
  ensureTerminalVisible
} from './helpers/store'

test.describe('Tab Rename (Inline)', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
    await ensureTerminalVisible(mcodePage)
    // Why: clear any custom titles left by a previous test (the Electron app
    // persists across tests in the worker) so tab locators key off the default
    // title, not a stale rename like "My Custom Title".
    await mcodePage.evaluate(() => {
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
    return tab!.customTitle ?? tab!.title ?? ''
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

  async function dispatchMiddleClickSequence(
    locator: ReturnType<Parameters<typeof getActiveTabId>[0]['locator']>
  ): Promise<void> {
    await locator.evaluate((element) => {
      const eventInit = { bubbles: true, cancelable: true, button: 1 }
      element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, buttons: 4 }))
      element.dispatchEvent(new MouseEvent('mouseup', eventInit))
      element.dispatchEvent(new MouseEvent('auxclick', eventInit))
    })
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
    mcodePage
  }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const originalTitle = await getActiveTabTitle(mcodePage, worktreeId)
    expect(originalTitle.length).toBeGreaterThan(0)

    const tabLocator = tabLocatorByTitle(mcodePage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = mcodePage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('My Custom Title')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe('My Custom Title')
    await expect(renameInput).toBeHidden()
    await expect(tabLocatorByTitle(mcodePage, 'My Custom Title')).toBeVisible()
  })

  test('context-menu Change Title opens a focused select-all rename input', async ({
    mcodePage
  }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const originalTitle = await getActiveTabTitle(mcodePage, worktreeId)
    expect(originalTitle.length).toBeGreaterThan(0)

    await tabLocatorByTitle(mcodePage, originalTitle).click({ button: 'right' })
    await mcodePage.getByRole('menuitem', { name: 'Change Title', exact: true }).click()

    const renameInput = mcodePage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()
    await expect(renameInput).toBeFocused()

    // Why: after the context-menu path proves focus lands in the inline input,
    // fill avoids per-keystroke timing races in the shared full-suite browser.
    await renameInput.fill('Context Menu Title')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe('Context Menu Title')
    await expect(tabLocatorByTitle(mcodePage, 'Context Menu Title')).toBeVisible()
  })

  test('Escape during inline rename discards the edit', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const originalTitle = await getActiveTabTitle(mcodePage, worktreeId)

    const tabLocator = tabLocatorByTitle(mcodePage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = mcodePage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Should Be Discarded')
    await renameInput.press('Escape')

    await expect(renameInput).toBeHidden()
    // Why: the final assertion must be on user-observable DOM, not the store's
    // customTitle field. A render-layer bug where the tab silently paints the
    // in-progress "Should Be Discarded" text would leave customTitle null
    // (Escape cleared it) yet flash the discarded label to the user — the
    // original title must still be the one rendered on the tab.
    await expect(tabLocatorByTitle(mcodePage, originalTitle)).toBeVisible()
    await expect
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('renaming to an empty string resets the tab to its default title', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    // Snapshot the default (non-custom) title first so the DOM assertion later
    // can verify the tab reverts to *this exact* rendered text — a store-only
    // `customTitle === null` check would pass even if the rendered label was
    // stuck on "Seeded Custom".
    const defaultTitle = await getActiveTabTitle(mcodePage, worktreeId)
    expect(defaultTitle.length).toBeGreaterThan(0)

    // Why: seed a custom title directly via the store so this test asserts the
    // "empty string → reset" behavior independently from the double-click flow.
    await mcodePage.evaluate((targetWorktreeId) => {
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
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe('Seeded Custom')

    const tabLocator = tabLocatorByTitle(mcodePage, 'Seeded Custom')
    await tabLocator.dblclick()

    const renameInput = mcodePage.getByRole('textbox', {
      name: 'Rename tab Seeded Custom',
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('')
    await renameInput.press('Enter')

    // User-observable DOM assertion: the tab element must re-render with the
    // original default title, not the "Seeded Custom" override.
    await expect(tabLocatorByTitle(mcodePage, defaultTitle)).toBeVisible()
    await expect
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('clicking away (blur) commits the rename', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!

    // Why: need a second tab so we have something to click that isn't the
    // rename input itself. Seed both with known titles so we can locate them.
    await mcodePage.evaluate((targetWorktreeId) => {
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
      .poll(async () => (await getWorktreeTabs(mcodePage, worktreeId)).length, { timeout: 3_000 })
      .toBeGreaterThanOrEqual(2)

    const tabs = await getWorktreeTabs(mcodePage, worktreeId)
    const activeId = await getActiveTabId(mcodePage)
    const activeTab = tabs.find((t) => t.id === activeId)!
    const otherTab = tabs.find((t) => t.id !== activeId)!

    const tabLocator = tabLocatorByTitle(mcodePage, activeTab.title!)
    await tabLocator.dblclick()

    const renameInput = mcodePage.getByRole('textbox', {
      name: `Rename tab ${activeTab.title}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    await renameInput.fill('Committed By Blur')
    // Why: clicking the other tab triggers blur on the input, which should
    // run commitRename and save the typed title before the focus shifts.
    await tabLocatorByTitle(mcodePage, otherTab.title!).click()

    await expect(renameInput).toBeHidden()
    await expect(tabLocatorByTitle(mcodePage, 'Committed By Blur')).toBeVisible()
    expect(
      await mcodePage.evaluate(
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
    mcodePage
  }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const originalTitle = await getActiveTabTitle(mcodePage, worktreeId)

    const tabLocator = tabLocatorByTitle(mcodePage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = mcodePage.getByRole('textbox', {
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
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe('Committed By Right Click')
    await expect(renameInput).toBeHidden()
  })

  test('terminal title updates do not resize neighboring tabs', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const tabIds = await mcodePage.evaluate((targetWorktreeId) => {
      const state = window.__store!.getState()
      const existing = state.tabsByWorktree[targetWorktreeId] ?? []
      for (let index = existing.length; index < 3; index += 1) {
        state.createTab(targetWorktreeId, undefined, undefined, { activate: false })
      }
      const ids = (window.__store!.getState().tabsByWorktree[targetWorktreeId] ?? [])
        .slice(0, 3)
        .map((tab) => tab.id)
      ids.forEach((id, index) => state.setTabCustomTitle(id, `Tab ${index + 1}`))
      return ids
    }, worktreeId)

    const tabs = tabIds.map((id) =>
      mcodePage.locator(`[data-testid="sortable-tab"][data-tab-id="${id}"]`)
    )
    await expect(tabs[2]!).toBeVisible()
    const before = await Promise.all(
      tabs.map((tab) => tab.evaluate((element) => element.getBoundingClientRect().width))
    )
    // Why: at the 88px shrink floor widths are stable for the wrong reason, and being above it is
    // also what proves the definite tab width applied — so this fails first on a regression.
    expect(
      Math.min(...before),
      'tabs must be above the 88px shrink floor for the stability check to mean anything'
    ).toBeGreaterThan(88)

    await mcodePage.evaluate(
      ({ tabId }) => {
        window
          .__store!.getState()
          .setTabCustomTitle(
            tabId,
            'Continuously changing generated terminal title that must remain constrained'
          )
      },
      { tabId: tabIds[0] }
    )
    await expect(tabs[0]!).toContainText('Continuously changing generated terminal title')
    const after = await Promise.all(
      tabs.map((tab) => tab.evaluate((element) => element.getBoundingClientRect().width))
    )

    after.forEach((width, index) => expect(Math.abs(width - before[index]!)).toBeLessThanOrEqual(1))
    await tabs[2]!.click()
    await expect(tabs[2]!).toHaveAttribute('data-active', 'true')
  })

  test('rename input stays at a usable width when many tabs are open', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const targetTabId = await getActiveTabId(mcodePage)
    expect(targetTabId).not.toBeNull()
    const targetTitle = 'Width Target Tab'

    // Why: create enough terminal tabs that flex space runs out. 15 is well
    // above the threshold at which the pre-fix input collapsed, and it keeps
    // the test fast. The width fix pins the input to 72px (matching the
    // slimmer tab title box), so even saturated, it should stay near that
    // size — we assert ≥60px to allow a bit of slack for fonts/padding/
    // containers differing between environments. The meaningful guarantee is
    // that the input does not collapse to ~0 when flex space is saturated.
    await mcodePage.evaluate(
      ({ targetWorktreeId, targetTabId, targetTitle }) => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        const existing = state.tabsByWorktree[targetWorktreeId] ?? []
        for (const [index, tab] of existing.entries()) {
          // Why: shell-driven terminal title updates can race this crowded-tab
          // assertion; custom titles keep the rename target stable.
          state.setTabCustomTitle(
            tab.id,
            tab.id === targetTabId ? targetTitle : `Width Filler ${index + 1}`
          )
        }
        for (let i = existing.length; i < 15; i++) {
          const tab = state.createTab(targetWorktreeId, undefined, undefined, { activate: false })
          state.setTabCustomTitle(tab.id, `Width Filler ${i + 1}`)
        }
      },
      { targetWorktreeId: worktreeId, targetTabId, targetTitle }
    )

    await expect
      .poll(async () => (await getWorktreeTabs(mcodePage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(15)
    await expect
      .poll(async () => getActiveCustomTitle(mcodePage, worktreeId), { timeout: 3_000 })
      .toBe(targetTitle)

    const tabLocator = tabLocatorByTitle(mcodePage, targetTitle)
    await tabLocator.scrollIntoViewIfNeeded()
    await expect(tabLocator).toBeVisible()
    // Why: once 15 tabs are packed into the strip, the tab center can overlap
    // the close affordance. Target the visible title text, which is the rename
    // hit area users aim for.
    const tabTitle = tabLocator.getByText(targetTitle, { exact: true })
    await expect(tabTitle).toBeVisible()
    // Why: this spec is about saturated-tab input width. The real pointer
    // double-click path is covered above; dispatching the tab's own dblclick
    // handler avoids pixel-level overlap flakes in the crowded strip.
    await tabLocator.evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          button: 0
        })
      )
    })

    const renameInput = mcodePage.getByRole('textbox', {
      name: `Rename tab ${targetTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    const width = await renameInput.evaluate((element) => element.getBoundingClientRect().width)
    expect(width).toBeGreaterThanOrEqual(60)
  })

  test('middle-clicking inside the rename input does not close the tab', async ({ mcodePage }) => {
    const worktreeId = (await getActiveWorktreeId(mcodePage))!
    const tabsBefore = (await getWorktreeTabs(mcodePage, worktreeId)).length
    const originalTitle = await getActiveTabTitle(mcodePage, worktreeId)

    const tabLocator = tabLocatorByTitle(mcodePage, originalTitle)
    await tabLocator.dblclick()

    const renameInput = mcodePage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    // Why: the outer tab's middle-click handler closes the tab. The rename
    // input stops propagation + preventDefaults middle-click so the tab
    // isn't closed while the user is editing.
    await dispatchMiddleClickSequence(renameInput)

    // The tab must still exist — no regression where editing-then-middle-click
    // accidentally closes the tab out from under the input.
    await expect(renameInput).toBeVisible()
    await expect(tabLocatorByTitle(mcodePage, originalTitle)).toBeVisible()
    expect((await getWorktreeTabs(mcodePage, worktreeId)).length).toBe(tabsBefore)
  })
})
