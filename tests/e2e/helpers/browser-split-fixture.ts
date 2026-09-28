/**
 * Split-layout fixtures for browser shortcut E2E specs: a terminal beside a browser, or two
 * browsers side by side, plus helpers that press real chords inside a registered guest.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
export const guestModifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control'

export type GuestModifier = 'meta' | 'control' | 'alt' | 'shift'

export type TerminalBrowserSplitFixture = {
  browserGroupId: string
  browserPageId: string
  browserTabId: string
  terminalGroupId: string
}

export type BrowserSplitFixture = {
  firstBrowserGroupId: string
  firstBrowserPageId: string
  firstBrowserTabId: string
  secondBrowserGroupId: string
  secondBrowserPageId: string
  secondBrowserTabId: string
}

/** Preserves the active terminal beside a browser to test shortcuts across content types. */
export async function createTerminalBrowserSplit(
  page: Page,
  url = 'about:blank'
): Promise<TerminalBrowserSplitFixture> {
  return page.evaluate((initialUrl) => {
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
    const browserTab = state.createBrowserTab(worktreeId, initialUrl, {
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
      browserPageId,
      browserTabId: browserTab.id,
      terminalGroupId
    }
  }, url)
}

/** Seeds two browser splits; served URLs avoid the about:blank overlay during guest click tests. */
export async function createBrowserSplit(
  page: Page,
  urls: { first: string; second: string } = { first: 'about:blank', second: 'about:blank' }
): Promise<BrowserSplitFixture> {
  return page.evaluate((initialUrls) => {
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
    const firstBrowserTab = state.createBrowserTab(worktreeId, initialUrls.first, {
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
    const secondBrowserTab = state.createBrowserTab(worktreeId, initialUrls.second, {
      activate: true,
      focusAddressBar: false,
      targetGroupId: secondBrowserGroupId
    })
    const firstBrowserPageId = firstBrowserTab.activePageId
    const secondBrowserPageId = secondBrowserTab.activePageId
    if (!firstBrowserPageId || !secondBrowserPageId) {
      throw new Error('Active browser page unavailable')
    }
    return {
      firstBrowserGroupId,
      firstBrowserPageId,
      firstBrowserTabId: firstBrowserTab.id,
      secondBrowserGroupId,
      secondBrowserPageId,
      secondBrowserTabId: secondBrowserTab.id
    }
  }, urls)
}

export function browserOverlay(page: Page, browserTabId: string) {
  return page.locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
}

/** Scopes address-bar lookup to one overlay because both browser splits can be visible. */
export function browserAddressBar(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).locator('[data-orca-browser-address-bar="true"]')
}

/** Establishes host-renderer focus before testing a transition into a separate browser guest. */
export async function focusBrowserAddressBar(page: Page, browserTabId: string): Promise<void> {
  const addressBar = browserAddressBar(page, browserTabId)
  const addressBarForm = browserOverlay(page, browserTabId).locator(
    'form:has(> [data-orca-browser-address-bar="true"])'
  )
  await expect(addressBarForm).toBeVisible()
  await addressBar.focus()
  await expect(addressBar).toBeFocused()
}

export async function waitForBrowserGuestRegistration(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ targetBrowserPageId, targetBrowserTabId }) => {
          const webview = document.querySelector<Electron.WebviewTag>(
            `[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`
          )
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

/** Types a chord into the guest's own WebContents, the path main forwards back to the renderer. */
export async function pressKeyInBrowserGuest(
  page: Page,
  browserTabId: string,
  browserPageId: string,
  keyCode: string,
  modifiers: GuestModifier[]
): Promise<void> {
  await waitForBrowserGuestRegistration(page, browserTabId, browserPageId)
  await page.evaluate(
    async ({ targetBrowserTabId, inputKeyCode, inputModifiers }) => {
      const webview = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${targetBrowserTabId}"] webview`
      )
      if (!webview) {
        throw new Error('Registered browser guest unavailable')
      }
      webview.focus()
      await webview.sendInputEvent({
        type: 'keyDown',
        keyCode: inputKeyCode,
        modifiers: inputModifiers
      })
      await webview.sendInputEvent({
        type: 'keyUp',
        keyCode: inputKeyCode,
        modifiers: inputModifiers
      })
    },
    { targetBrowserTabId: browserTabId, inputKeyCode: keyCode, inputModifiers: modifiers }
  )
}

export async function waitForFocusedGroup(page: Page, groupId: string): Promise<void> {
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

export async function focusBrowserGroup(page: Page, groupId: string): Promise<void> {
  await page.evaluate((targetGroupId) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (state && worktreeId) {
      state.focusGroup(worktreeId, targetGroupId)
    }
  }, groupId)
  await waitForFocusedGroup(page, groupId)
}
