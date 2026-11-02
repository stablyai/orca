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
