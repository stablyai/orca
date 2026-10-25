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
    // Clear stale custom titles so default-title locators remain deterministic.
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
    // Why: getWorktreeTabs already folds customTitle into title, matching what the UI renders.
    return tab!.title ?? ''
  }

  function tabLocatorByTitle(
    page: Parameters<typeof getActiveTabId>[0],
    title: string
  ): ReturnType<Parameters<typeof getActiveTabId>[0]['locator']> {
    // Escape backslashes before quotes so newly inserted CSS escapes are not re-escaped.
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

  test('context-menu Change Title opens a focused select-all rename input', async ({
    orcaPage
  }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const originalTitle = await getActiveTabTitle(orcaPage, worktreeId)
    expect(originalTitle.length).toBeGreaterThan(0)

    await tabLocatorByTitle(orcaPage, originalTitle).click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: /^Change Title(?:\s|$)/ }).click()

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${originalTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()
    await expect(renameInput).toBeFocused()

    // After proving context-menu focus, fill avoids unrelated per-keystroke timing races.
    await renameInput.fill('Context Menu Title')
    await renameInput.press('Enter')

    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe('Context Menu Title')
    await expect(tabLocatorByTitle(orcaPage, 'Context Menu Title')).toBeVisible()
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
    // Assert the original rendered label; cleared customTitle alone can hide discarded edit text still on screen.
    await expect(tabLocatorByTitle(orcaPage, originalTitle)).toBeVisible()
    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('renaming to an empty string resets the tab to its default title', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Record the exact default label before seeding so reset must restore its DOM text.
    const defaultTitle = await getActiveTabTitle(orcaPage, worktreeId)
    expect(defaultTitle.length).toBeGreaterThan(0)

    // Seed directly to isolate empty-string reset from double-click rename.
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

    await expect(tabLocatorByTitle(orcaPage, defaultTitle)).toBeVisible()
    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe(null)
  })

  test('clicking away (blur) commits the rename', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Create another titled tab as a deterministic blur target.
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
    // Selecting another tab must commit on blur before focus moves.
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
    // Right-click must commit rename on blur; menu details have independent coverage.
    await tabLocator.click({ button: 'right' })

    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe('Committed By Right Click')
    await expect(renameInput).toBeHidden()
  })

  test('terminal title updates do not resize neighboring tabs', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabIds = await orcaPage.evaluate((targetWorktreeId) => {
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
      orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${id}"]`)
    )
    await expect(tabs[2]!).toBeVisible()
    const before = await Promise.all(
      tabs.map((tab) => tab.evaluate((element) => element.getBoundingClientRect().width))
    )
    // Require width above the 88px shrink floor; otherwise stable widths can mask a failed definite tab width.
    expect(
      Math.min(...before),
      'tabs must be above the 88px shrink floor for the stability check to mean anything'
    ).toBeGreaterThan(88)

    await orcaPage.evaluate(
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

  test('rename input stays at a usable width when many tabs are open', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const targetTabId = await getActiveTabId(orcaPage)
    expect(targetTabId).not.toBeNull()
    const targetTitle = 'Width Target Tab'

    // Saturate flex space with 15 tabs and require ≥60px input width around the 72px target, rejecting collapse toward zero.
    await orcaPage.evaluate(
      ({ targetWorktreeId, targetTabId, targetTitle }) => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        const existing = state.tabsByWorktree[targetWorktreeId] ?? []
        for (const [index, tab] of existing.entries()) {
          // Use custom titles so shell updates cannot race crowded-tab selection.
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
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(15)
    await expect
      .poll(async () => getActiveCustomTitle(orcaPage, worktreeId), { timeout: 3_000 })
      .toBe(targetTitle)

    const tabLocator = tabLocatorByTitle(orcaPage, targetTitle)
    await tabLocator.scrollIntoViewIfNeeded()
    await expect(tabLocator).toBeVisible()
    // Target title text because packed tab centers can overlap close buttons.
    const tabTitle = tabLocator.getByText(targetTitle, { exact: true })
    await expect(tabTitle).toBeVisible()
    // Dispatch dblclick to isolate saturated width; earlier tests cover real pointer double-click.
    await tabLocator.evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          button: 0
        })
      )
    })

    const renameInput = orcaPage.getByRole('textbox', {
      name: `Rename tab ${targetTitle}`,
      exact: true
    })
    await expect(renameInput).toBeVisible()

    const width = await renameInput.evaluate((element) => element.getBoundingClientRect().width)
    expect(width).toBeGreaterThanOrEqual(60)
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

    // Middle-click must stop at the rename input instead of bubbling to tab close.
    await dispatchMiddleClickSequence(renameInput)

    await expect(renameInput).toBeVisible()
    await expect(tabLocatorByTitle(orcaPage, originalTitle)).toBeVisible()
    expect((await getWorktreeTabs(orcaPage, worktreeId)).length).toBe(tabsBefore)
  })
})
