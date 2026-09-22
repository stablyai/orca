import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const guestModifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control'

type TerminalBrowserSplitFixture = {
  browserGroupId: string
  browserTabId: string
  terminalGroupId: string
}

type BrowserSplitFixture = {
  firstBrowserPageId: string
  firstBrowserTabId: string
  secondBrowserTabId: string
}

async function createTerminalBrowserSplit(page: Page): Promise<TerminalBrowserSplitFixture> {
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
    const terminalTabId = state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId ?? undefined
    if (
      !terminalTabId ||
      !(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === terminalTabId)
    ) {
      throw new Error('Active terminal tab unavailable')
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
    const browserPageId = browserTab.activePageId
    if (!browserPageId) {
      throw new Error('Active browser page unavailable')
    }
    return {
      browserGroupId,
      browserTabId: browserTab.id,
      terminalGroupId
    }
  })
}

async function createBrowserSplit(page: Page): Promise<BrowserSplitFixture> {
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
    const firstBrowserGroupId = state.createEmptySplitGroup(worktreeId, terminalGroupId, 'right')
    if (!firstBrowserGroupId) {
      throw new Error('First browser split unavailable')
    }
    const firstBrowserTab = state.createBrowserTab(worktreeId, 'about:blank', {
      activate: true,
      focusAddressBar: false,
      targetGroupId: firstBrowserGroupId
    })
    const secondBrowserGroupId = state.createEmptySplitGroup(
      worktreeId,
      firstBrowserGroupId,
      'right'
    )
    if (!secondBrowserGroupId) {
      throw new Error('Second browser split unavailable')
    }
    const secondBrowserTab = state.createBrowserTab(worktreeId, 'about:blank', {
      activate: true,
      focusAddressBar: false,
      targetGroupId: secondBrowserGroupId
    })
    const firstBrowserPageId = firstBrowserTab.activePageId
    if (!firstBrowserPageId) {
      throw new Error('First active browser page unavailable')
    }
    return {
      firstBrowserPageId,
      firstBrowserTabId: firstBrowserTab.id,
      secondBrowserTabId: secondBrowserTab.id
    }
  })
}

function browserAddressBar(page: Page, browserTabId: string) {
  return page.locator(
    `[data-browser-overlay-tab-id="${browserTabId}"] [data-orca-browser-address-bar="true"]`
  )
}

async function focusBrowserAddressBar(page: Page, browserTabId: string): Promise<void> {
  const browserOverlay = page.locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
  const addressBar = browserAddressBar(page, browserTabId)
  const addressBarForm = browserOverlay.locator(
    'form:has(> [data-orca-browser-address-bar="true"])'
  )
  await expect(addressBarForm).toBeVisible()
  await addressBar.focus()
  await expect(addressBar).toBeFocused()
}

function browserFindInput(page: Page) {
  return page.getByPlaceholder('Find in page...')
}

function browserFindCloseButton(page: Page) {
  return browserFindInput(page).locator('xpath=..').getByTitle('Close')
}

function browserSplitFindInput(page: Page, browserTabId: string) {
  return page
    .locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
    .getByPlaceholder('Find in page...')
}

async function waitForBrowserGuestRegistration(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ targetBrowserPageId, targetBrowserTabId }) => {
          const overlay = document.querySelector(
            `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
          )
          const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
          try {
            if (!webview) {
              return false
            }
            const webContentsId = webview.getWebContentsId()
            const registered = await window.api.browser.isGuestRegistered({
              browserPageId: targetBrowserPageId,
              webContentsId
            })
            if (!registered) {
              return false
            }
            return true
          } catch {
            return false
          }
        },
        {
          targetBrowserPageId: browserPageId,
          targetBrowserTabId: browserTabId
        }
      )
    )
    .toBe(true)
}

async function pressFindInBrowserGuest(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await waitForBrowserGuestRegistration(page, browserTabId, browserPageId)
  await page.evaluate(
    async ({ targetBrowserTabId, inputModifier }) => {
      const overlay = document.querySelector(
        `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
      )
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        throw new Error('Registered browser guest unavailable')
      }
      webview.focus()
      await webview.sendInputEvent({
        type: 'keyDown',
        keyCode: 'F',
        modifiers: [inputModifier]
      })
      await webview.sendInputEvent({
        type: 'keyUp',
        keyCode: 'F',
        modifiers: [inputModifier]
      })
    },
    { targetBrowserTabId: browserTabId, inputModifier: guestModifier }
  )
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

async function focusBrowserGroup(page: Page, groupId: string): Promise<void> {
  await page.evaluate((targetGroupId) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (state && worktreeId) {
      state.focusGroup(worktreeId, targetGroupId)
    }
  }, groupId)
  await waitForFocusedGroup(page, groupId)
}

test.describe('browser split shortcuts', () => {
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

    await focusBrowserGroup(orcaPage, fixture.browserGroupId)
    await focusBrowserAddressBar(orcaPage, fixture.browserTabId)
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

  test('opens Find only in the browser split whose guest owns the shortcut', async ({
    orcaPage
  }) => {
    const fixture = await createBrowserSplit(orcaPage)

    await pressFindInBrowserGuest(orcaPage, fixture.firstBrowserTabId, fixture.firstBrowserPageId)

    await expect(browserSplitFindInput(orcaPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(browserSplitFindInput(orcaPage, fixture.secondBrowserTabId)).toBeHidden()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ browserPageId, browserTabId }) =>
            window.__store
              ?.getState()
              .browserPagesByWorkspace[browserTabId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null,
          {
            browserPageId: fixture.firstBrowserPageId,
            browserTabId: fixture.firstBrowserTabId
          }
        )
      )
      .toBeNull()
  })

  test('keeps browser Find available when split focus state is temporarily missing', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)
    await focusBrowserGroup(orcaPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(orcaPage, fixture.browserTabId)
    await focusBrowserAddressBar(orcaPage, fixture.browserTabId)

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
    await focusBrowserGroup(orcaPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(orcaPage, fixture.browserTabId)
    await focusBrowserAddressBar(orcaPage, fixture.browserTabId)

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
