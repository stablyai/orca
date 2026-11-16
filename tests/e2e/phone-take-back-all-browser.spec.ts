// #40859: "Take back all" on either phone banner hands back both the terminal and the browser tab.
import { createServer } from 'node:http'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { createTerminalBrowserSplit } from './helpers/browser-split-fixture'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'

// The phone app's mobile view on a 390x844 screen; main clamps the height to the desktop guest.
const PHONE_WIDTH = 390

async function guestViewport(
  electronApp: ElectronApplication,
  url: string
): Promise<{ width: number; height: number } | null> {
  return electronApp.evaluate(async ({ webContents }, pageUrl) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === 'webview' && contents.getURL() === pageUrl)
    return guest ? guest.executeJavaScript('({ width: innerWidth, height: innerHeight })') : null
  }, url)
}

const BANNERS = [
  { surface: 'terminal', selector: '.mobile-driver-banner' },
  { surface: 'browser tab', selector: '.mobile-browser-driver-banner' }
]

for (const banner of BANNERS) {
  test(`Take back all on the ${banner.surface} banner takes back everything the phone holds`, async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    // CI's 1280px xvfb screen leaves the split guest narrower than the phone unless sidebars close.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900)
    })
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.setSidebarOpen(false)
      state?.setRightSidebarOpen(false)
    })

    // A drawing http page: Orca shows data: and blank URLs as its New Tab view.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        '<!doctype html><meta name="viewport" content="width=device-width"><h1>page</h1>'
      )
    })
    let phone: PairedMobileClient | null = null
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      const url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}/`
      const { browserPageId } = await createTerminalBrowserSplit(orcaPage, url)
      await expect
        .poll(async () => (await guestViewport(electronApp, url))?.width ?? 0, { timeout: 30_000 })
        .toBeGreaterThan(PHONE_WIDTH)
      const desktopViewport = await guestViewport(electronApp, url)

      phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
      const socket = await phone.openSocket()
      const { terminals } = await phone.call<{ terminals: { handle: string; ptyId: string }[] }>(
        'terminal.list',
        { worktree: `id:${worktreeId}` }
      )
      const terminal = terminals.find((entry) => entry.ptyId === ptyId)?.handle
      expect(terminal, 'the phone lists the desktop terminal').toBeTruthy()
      socket.send('subscribe', 'terminal.subscribe', {
        terminal,
        client: { id: socket.token, type: 'mobile' },
        viewport: { cols: 40, rows: 30 },
        capabilities: { terminalBinaryStream: 1 }
      })
      socket.send('screencast', 'browser.screencast', {
        worktree: `id:${worktreeId}`,
        page: browserPageId,
        format: 'jpeg',
        quality: 72,
        maxWidth: 780,
        maxHeight: 1688,
        everyNthFrame: 1,
        minFrameIntervalMs: 100,
        viewportWidth: PHONE_WIDTH,
        viewportHeight: 844,
        deviceScaleFactor: 2,
        mobile: true,
        frameAck: 1
      })
      const browserOverlay = orcaPage.locator('.mobile-browser-driver-banner')
      await expect(browserOverlay).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(async () => (await guestViewport(electronApp, url))?.width)
        .toBe(PHONE_WIDTH)

      await expect(orcaPage.locator('.mobile-driver-banner')).toBeVisible()
      await orcaPage
        .locator(banner.selector)
        .getByRole('button', { name: /^take back all$/i })
        .click()

      await expect(orcaPage.locator('.mobile-driver-banner')).toHaveCount(0)
      await expect(browserOverlay).toHaveCount(0)
      await expect.poll(() => guestViewport(electronApp, url)).toEqual(desktopViewport)
    } finally {
      phone?.dispose()
      server.close()
    }
  })
}
