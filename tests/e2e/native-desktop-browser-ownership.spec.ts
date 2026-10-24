import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { peerNativeWindow, captureNativeBrowserGuest } from './helpers/native-desktop-window'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'
import { waitForGuestIdle } from './helpers/browser-split-guest-probes'

async function guestIdentity(page: Page, tabId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const guest = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${id}"] webview`
    )
    return guest?.executeJavaScript('({ userAgent: navigator.userAgent, width: innerWidth })')
  }, tabId)
}

test('shared native guests keep independent viewport identity and deliver links to the opener window', async ({
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
        throw new Error('Missing browser page')
      }
      return { key, tabId: tab.id, pageId: tab.activePageId }
    },
    server.pageUrl('native-owner', 1)
  )
  await waitForGuestIdle(orcaPage, target.tabId)
  await expect
    .poll(() =>
      orcaPage.evaluate(
        async ({ tabId, pageId }) =>
          (await window.api.session.get()).browserPagesByWorkspace?.[tabId]?.some(
            (page) => page.id === pageId
          ),
        target
      )
    )
    .toBe(true)
  const peer = await peerNativeWindow(electronApp, orcaPage)
  await peer.evaluate(({ key, tabId }) => {
    const state = window.__store?.getState()
    state?.setActiveBrowserTab(tabId, key)
    state?.setActiveTabType('browser', key)
  }, target)
  await waitForGuestIdle(peer, target.tabId)
  const apply = (page: Page, mobile: boolean) =>
    page.evaluate(
      ({ pageId, mobile }) =>
        window.api.browser.setViewportOverride({
          browserPageId: pageId,
          override: mobile
            ? { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
            : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
        }),
      { pageId: target.pageId, mobile }
    )
  const results = await Promise.all([apply(orcaPage, true), apply(peer, false)])
  expect(results).toEqual([true, true])
  expect(await guestIdentity(orcaPage, target.tabId)).toMatchObject({
    userAgent: expect.stringContaining('iPhone')
  })
  expect(await guestIdentity(peer, target.tabId)).toMatchObject({
    userAgent: expect.not.stringContaining('iPhone')
  })
  const screenshot = testInfo.outputPath('native-mobile-guest.png')
  await captureNativeBrowserGuest(electronApp, orcaPage, target.tabId, screenshot)
  await testInfo.attach('native-mobile-guest', { path: screenshot, contentType: 'image/png' })
  expect(
    await peer.evaluate(({ tabId, pageId }) => {
      const guest = document.querySelector<Electron.WebviewTag>(
        `[data-browser-overlay-tab-id="${tabId}"] webview`
      )
      return window.api.browser.isGuestRegistered({
        browserPageId: pageId,
        webContentsId: guest?.getWebContentsId() ?? -1
      })
    }, target)
  ).toBe(true)
  const firstWindow = await electronApp.browserWindow(orcaPage)
  const peerWindow = await electronApp.browserWindow(peer)
  const firstId = await firstWindow.evaluate((window) => window.webContents.id)
  const peerId = await peerWindow.evaluate((window) => window.webContents.id)
  const link = server.pageUrl('native-owned-link', 2)
  const delivery = await electronApp.evaluate(
    async ({ webContents }, args) => {
      const first = webContents.fromId(args.firstId)
      const peer = webContents.fromId(args.peerId)
      const guestId = await first?.executeJavaScript(
        `document.querySelector('[data-browser-overlay-tab-id="${args.tabId}"] webview').getWebContentsId()`
      )
      const guest = typeof guestId === 'number' ? webContents.fromId(guestId) : null
      if (!first || !peer || !guest) {
        throw new Error('Missing native link targets')
      }
      const received = Promise.withResolvers<number>()
      const restorations: (() => void)[] = []
      for (const renderer of [first, peer]) {
        const send = renderer.send.bind(renderer)
        renderer.send = (channel, ...args) => {
          if (channel === 'browser:open-link-in-orca-tab') {
            received.resolve(renderer.id)
          }
          send(channel, ...args)
        }
        restorations.push(() => {
          renderer.send = send
        })
      }
      const timeout = setTimeout(() => received.reject(new Error('No native tab delivery')), 10_000)
      try {
        await guest.executeJavaScript(`window.open(${JSON.stringify(args.link)}, '_blank')`)
        return await received.promise
      } finally {
        clearTimeout(timeout)
        for (const restore of restorations) {
          restore()
        }
      }
    },
    { firstId, peerId, tabId: target.tabId, link }
  )
  expect(delivery).toBe(firstId)
})
