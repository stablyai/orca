import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

type SplitFindFixture = {
  browserGroupId: string
  browserTabId: string
  terminalGroupId: string
}

async function createTerminalBrowserSplit(page: Page): Promise<SplitFindFixture> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('Active worktree unavailable')
    }
    const terminalGroupId = state.ensureWorktreeRootGroup(worktreeId)
    const browserGroupId = state.createEmptySplitGroup(worktreeId, terminalGroupId, 'right')
    if (!browserGroupId) {
      throw new Error('Browser split unavailable')
    }
    const browserTab = state.createBrowserTab(worktreeId, 'about:blank', {
      activate: true,
      focusAddressBar: false,
      targetGroupId: browserGroupId
    })
    return { browserGroupId, browserTabId: browserTab.id, terminalGroupId }
  })
}

function browserAddressBar(page: Page, browserTabId: string) {
  return page.locator(
    `[data-browser-overlay-tab-id="${browserTabId}"] [data-orca-browser-address-bar="true"]`
  )
}

function browserFindInput(page: Page) {
  return page.getByPlaceholder('Find in page...')
}

function browserFindCloseButton(page: Page) {
  return browserFindInput(page).locator('xpath=..').getByTitle('Close')
}

function terminalFindInput(page: Page) {
  return page.locator('[data-terminal-search-root] input:visible')
}

async function waitForFocusedGroup(page: Page, groupId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return worktreeId ? state.activeGroupIdByWorktree[worktreeId] : null
      })
    )
    .toBe(groupId)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

test.describe('browser split Find shortcut', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('routes repeated Find shortcuts to the focused terminal or browser split', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)

    await orcaPage.evaluate(({ terminalGroupId }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      if (state && worktreeId) {
        state.focusGroup(worktreeId, terminalGroupId)
      }
    }, fixture)
    await focusActiveTerminalInput(orcaPage)
    await waitForFocusedGroup(orcaPage, fixture.terminalGroupId)
    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(orcaPage)).toBeFocused()
    await expect(browserFindInput(orcaPage)).toBeHidden()
    await orcaPage.keyboard.press('Escape')

    await browserAddressBar(orcaPage, fixture.browserTabId).click()
    await waitForFocusedGroup(orcaPage, fixture.browserGroupId)
    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await expect(terminalFindInput(orcaPage)).toBeHidden()
    await browserFindCloseButton(orcaPage).click()
    await expect(browserFindInput(orcaPage)).toBeHidden()

    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await browserFindCloseButton(orcaPage).click()

    await orcaPage.evaluate(({ browserTabId }) => {
      window.__store?.getState().closeBrowserTab(browserTabId)
    }, fixture)
    await expect(
      orcaPage.locator(`[data-browser-overlay-tab-id="${fixture.browserTabId}"]`)
    ).toHaveCount(0)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(orcaPage)).toBeFocused()
    await expect(browserFindInput(orcaPage)).toBeHidden()
  })

  test('keeps browser Find available when split focus state is temporarily missing', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)
    const addressBar = browserAddressBar(orcaPage, fixture.browserTabId)
    await addressBar.click()
    await expect(addressBar).toBeFocused()

    await orcaPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => {
        const activeGroupIdByWorktree = { ...state.activeGroupIdByWorktree }
        delete activeGroupIdByWorktree[worktreeId]
        return { activeGroupIdByWorktree }
      })
    })
    await expect(addressBar).toBeFocused()

    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await expect(terminalFindInput(orcaPage)).toBeHidden()
  })

  test('keeps browser Find available when the focused split ID is stale', async ({ orcaPage }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)
    const addressBar = browserAddressBar(orcaPage, fixture.browserTabId)
    await addressBar.click()
    await expect(addressBar).toBeFocused()

    await orcaPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => ({
        activeGroupIdByWorktree: {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: 'removed-group'
        }
      }))
    })
    await expect(addressBar).toBeFocused()

    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await expect(terminalFindInput(orcaPage)).toBeHidden()
  })
})
