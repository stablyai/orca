import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  peerNativeWindow as peerWindow,
  expectNativeTabOrder,
  captureNativeBrowserGuest
} from './helpers/native-desktop-window'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'

test('an unsaved rename and reorder survive a peer saving to the same workspace first', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(180_000)
  const workspace = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('No workspace')
    }
    state.createTab(state.activeWorktreeId, undefined, undefined, { activate: false })
    return state.activeWorktreeId
  })
  const peer = await peerWindow(electronApp, orcaPage)
  await expect
    .poll(() =>
      peer.evaluate(
        (key) => window.__store?.getState().unifiedTabsByWorktree[key]?.length ?? 0,
        workspace
      )
    )
    .toBeGreaterThanOrEqual(2)
  await orcaPage.evaluate(() => {
    const schedule = window.setTimeout.bind(window)
    const cancel = window.clearTimeout.bind(window)
    const pending = new Map<number, () => void>()
    Object.defineProperty(window, 'setTimeout', {
      configurable: true,
      writable: true,
      value: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay !== 150 || typeof handler !== 'function') {
          return schedule(handler, delay, ...args)
        }
        const id = schedule(() => {
          pending.delete(id)
          handler(...args)
        }, 60_000)
        pending.set(id, () => {
          cancel(id)
          handler(...args)
        })
        return id
      }
    })
    window.clearTimeout = (id) => {
      pending.delete(id ?? 0)
      cancel(id)
    }
    window.addEventListener(
      'release-native-session-writes',
      () => {
        window.setTimeout = schedule
        window.clearTimeout = cancel
        for (const flush of pending.values()) {
          flush()
        }
        pending.clear()
      },
      { once: true }
    )
  })
  try {
    const target = await orcaPage.evaluate((key) => {
      const state = window.__store?.getState()
      const group = state?.groupsByWorktree[key]?.find((group) => group.tabOrder.length >= 2)
      const id = group?.tabOrder[0]
      const tab = state?.unifiedTabsByWorktree[key]?.find((candidate) => candidate.id === id)
      if (!state || !group || !id || tab?.contentType !== 'terminal') {
        throw new Error('No reorderable tabs')
      }
      state.setTabCustomTitle(tab.entityId, 'Pending native rename')
      state.reorderUnifiedTabs(group.id, group.tabOrder.toReversed())
      return {
        id,
        entityId: tab.entityId,
        groupId: group.id,
        initialOrder: group.tabOrder,
        order:
          window.__store
            ?.getState()
            .groupsByWorktree[key]?.find((candidate) => candidate.id === group.id)?.tabOrder ?? []
      }
    }, workspace)
    const renamed = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${target.id}"]`)
    await expect(renamed).toBeVisible()
    await expect(renamed).toHaveAttribute('data-tab-title', 'Pending native rename')
    await expect(renamed).toContainText('Pending native rename')
    await expectNativeTabOrder(orcaPage, target.groupId, target.order)
    await peer.evaluate(
      (entityId) => window.__store?.getState().setTabColor(entityId, '#008800'),
      target.entityId
    )
    await expect
      .poll(
        () =>
          peer.evaluate(
            async ({ key, id, entityId }) => {
              const session = await window.api.session.get()
              return [
                session.unifiedTabs?.[key]?.find((tab) => tab.id === id)?.color,
                session.tabsByWorktree[key]?.find((tab) => tab.id === entityId)?.color
              ]
            },
            { key: workspace, id: target.id, entityId: target.entityId }
          ),
        { timeout: 15_000 }
      )
      .toEqual(['#008800', '#008800'])
    await expect
      .poll(
        async () => {
          return orcaPage.evaluate(
            ({ key, id }) =>
              window.__store?.getState().unifiedTabsByWorktree[key]?.find((tab) => tab.id === id)
                ?.color,
            { key: workspace, id: target.id }
          )
        },
        { timeout: 30_000 }
      )
      .toBe('#008800')
    expect(
      await orcaPage.evaluate(
        ({ key, id }) =>
          window.__store?.getState().unifiedTabsByWorktree[key]?.find((tab) => tab.id === id)
            ?.customLabel,
        { key: workspace, id: target.id }
      )
    ).toBe('Pending native rename')
    expect(
      await orcaPage.evaluate(
        ({ key, groupId }) =>
          window.__store?.getState().groupsByWorktree[key]?.find((group) => group.id === groupId)
            ?.tabOrder,
        { key: workspace, groupId: target.groupId }
      )
    ).toEqual(target.order)
    await expect(renamed).toHaveAttribute('data-tab-title', 'Pending native rename')
    await expect(renamed).toContainText('Pending native rename')
    await expectNativeTabOrder(orcaPage, target.groupId, target.order)
    const savedBeforeRelease = await peer.evaluate(
      async ({ key, id, groupId }) => {
        const session = await window.api.session.get()
        return {
          label: session.unifiedTabs?.[key]?.find((tab) => tab.id === id)?.customLabel,
          order: session.tabGroups?.[key]?.find((group) => group.id === groupId)?.tabOrder
        }
      },
      { key: workspace, id: target.id, groupId: target.groupId }
    )
    expect(savedBeforeRelease.label).not.toBe('Pending native rename')
    expect(savedBeforeRelease.order).toEqual(target.initialOrder)
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('release-native-session-writes')))
    await expect
      .poll(
        () =>
          peer.evaluate(
            ({ key, id }) =>
              window.__store?.getState().unifiedTabsByWorktree[key]?.find((tab) => tab.id === id)
                ?.customLabel,
            { key: workspace, id: target.id }
          ),
        { timeout: 30_000 }
      )
      .toBe('Pending native rename')
    const peerRenamed = peer.locator(`[data-testid="sortable-tab"][data-tab-id="${target.id}"]`)
    await expect(peerRenamed).toBeVisible()
    await expect(peerRenamed).toHaveAttribute('data-tab-title', 'Pending native rename')
    await expect(peerRenamed).toContainText('Pending native rename')
    await expectNativeTabOrder(peer, target.groupId, target.order)
  } finally {
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('release-native-session-writes')))
  }
})

async function registered(page: Page, target: { tabId: string; pageId: string }): Promise<boolean> {
  return page.evaluate(async ({ tabId, pageId }) => {
    const guest = document.querySelector(`[data-browser-overlay-tab-id="${tabId}"] webview`)
    if (
      !(guest instanceof HTMLElement) ||
      !('getWebContentsId' in guest) ||
      typeof guest.getWebContentsId !== 'function'
    ) {
      return false
    }
    try {
      return window.api.browser.isGuestRegistered({
        browserPageId: pageId,
        webContentsId: guest.getWebContentsId()
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('dom-ready')) {
        return false
      }
      throw error
    }
  }, target)
}

async function guestTitle(page: Page, tabId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const guest = document.querySelector(`[data-browser-overlay-tab-id="${id}"] webview`)
    if (
      !(guest instanceof HTMLElement) ||
      !('executeJavaScript' in guest) ||
      typeof guest.executeJavaScript !== 'function'
    ) {
      return null
    }
    return guest.executeJavaScript('document.title')
  }, tabId)
}

test('the same saved browser page stays registered in both native windows through peer close and reopen', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  const server = await startBrowserSplitPageServer()
  registerPostElectronShutdownCleanup(server.close)
  const target = await orcaPage.evaluate(
    (url) => {
      const state = window.__store?.getState()
      const key = state?.activeWorktreeId
      const tab = key ? state?.createBrowserTab(key, url, { activate: true }) : null
      if (!tab?.activePageId || !key) {
        throw new Error('No browser page')
      }
      return { tabId: tab.id, pageId: tab.activePageId, key }
    },
    server.pageUrl('native-shared', 1)
  )
  await expect.poll(() => registered(orcaPage, target), { timeout: 30_000 }).toBe(true)
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          async ({ tabId, pageId }) =>
            (await window.api.session.get()).browserPagesByWorkspace?.[tabId]?.some(
              (page) => page.id === pageId
            ) ?? false,
          target
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
  const peer = await peerWindow(electronApp, orcaPage)
  await peer.evaluate(({ tabId, key }) => {
    const state = window.__store?.getState()
    state?.setActiveBrowserTab(tabId, key)
    state?.setActiveTabType('browser', key)
  }, target)
  await expect
    .poll(async () => (await registered(orcaPage, target)) && (await registered(peer, target)), {
      timeout: 30_000
    })
    .toBe(true)
  await expect.poll(() => guestTitle(orcaPage, target.tabId)).toBe('native-shared 1')
  await expect.poll(() => guestTitle(peer, target.tabId)).toBe('native-shared 1')
  const first = await electronApp.browserWindow(orcaPage)
  await first.evaluate((window) => window.close())
  await expect.poll(() => orcaPage.isClosed()).toBe(true)
  await expect.poll(() => registered(peer, target)).toBe(true)
  await expect.poll(() => guestTitle(peer, target.tabId)).toBe('native-shared 1')
  const reopened = await peerWindow(electronApp, peer)
  await reopened.evaluate(({ tabId, key }) => {
    const state = window.__store?.getState()
    state?.setActiveBrowserTab(tabId, key)
    state?.setActiveTabType('browser', key)
  }, target)
  await expect
    .poll(async () => (await registered(peer, target)) && (await registered(reopened, target)), {
      timeout: 30_000
    })
    .toBe(true)
  const second = await electronApp.browserWindow(peer)
  await second.evaluate((window) => window.close())
  await expect.poll(() => peer.isClosed()).toBe(true)
  await expect.poll(() => registered(reopened, target)).toBe(true)
  await expect.poll(() => guestTitle(reopened, target.tabId)).toBe('native-shared 1')
  const guestScreenshot = testInfo.outputPath('native-shared-browser-guest.png')
  await captureNativeBrowserGuest(electronApp, reopened, target.tabId, guestScreenshot)
  await testInfo.attach('native-shared-browser-guest', {
    path: guestScreenshot,
    contentType: 'image/png'
  })
  const screenshot = testInfo.outputPath('native-shared-browser.png')
  await reopened.screenshot({ path: screenshot })
  await testInfo.attach('native-shared-browser', { path: screenshot, contentType: 'image/png' })
})
