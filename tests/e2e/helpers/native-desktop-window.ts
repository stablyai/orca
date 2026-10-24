import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { writeFile } from 'node:fs/promises'
import { waitForSessionReady } from './store'

export async function peerNativeWindow(app: ElectronApplication, first: Page): Promise<Page> {
  const known = new Set(app.windows())
  expect(await first.evaluate(() => window.api.ui.openRuntimeClientWindow())).toEqual({ ok: true })
  await expect
    .poll(() =>
      app.windows().some((page) => !known.has(page) && /\/index\.html(?:[?#]|$)/.test(page.url()))
    )
    .toBe(true)
  const peer = app
    .windows()
    .find((page) => !known.has(page) && /\/index\.html(?:[?#]|$)/.test(page.url()))
  if (!peer) {
    throw new Error('Missing peer native window')
  }
  await peer.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(peer)
  return peer
}

export async function expectNativeTabOrder(
  page: Page,
  groupId: string,
  order: string[]
): Promise<void> {
  const strip = page.locator(`[data-tab-group-strip-id="${groupId}"]`)
  await expect(strip).toBeVisible()
  await expect
    .poll(() =>
      strip
        .locator('[data-testid="sortable-tab"][data-tab-id]')
        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id')))
    )
    .toEqual(order)
}

export async function captureNativeBrowserGuest(
  app: ElectronApplication,
  page: Page,
  tabId: string,
  screenshotPath: string
): Promise<void> {
  const guestId = await page.evaluate((id) => {
    const guest = document.querySelector(`[data-browser-overlay-tab-id="${id}"] webview`)
    if (!guest || !('getWebContentsId' in guest) || typeof guest.getWebContentsId !== 'function') {
      throw new Error('Missing native browser guest')
    }
    return guest.getWebContentsId()
  }, tabId)
  const captureGuest = () =>
    app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id)
      if (!guest || guest.isDestroyed()) {
        throw new Error('Native browser guest closed before capture')
      }
      const image = await guest.capturePage(undefined, { stayHidden: true })
      const bitmap = image.toBitmap()
      let dark = 0
      let light = 0
      for (let offset = 0; offset < bitmap.length; offset += 4) {
        const channels = [bitmap[offset]!, bitmap[offset + 1]!, bitmap[offset + 2]!]
        if (channels.every((channel) => channel < 100)) {
          dark += 1
        }
        if (channels.every((channel) => channel > 240)) {
          light += 1
        }
      }
      return { png: image.toPNG().toString('base64'), dark, light }
    }, guestId)
  let png: string | undefined
  await expect
    .poll(
      async () => {
        try {
          const capture = await captureGuest()
          if (capture.dark > 100 && capture.light > 1_000) {
            png = capture.png
            return true
          }
          return false
        } catch (error) {
          if (error instanceof Error && error.message.includes('UnknownVizError')) {
            return false
          }
          throw error
        }
      },
      { timeout: 10_000, message: 'Native browser guest must paint nonblank content' }
    )
    .toBe(true)
  if (!png) {
    throw new Error('Missing native browser pixels')
  }
  await writeFile(screenshotPath, Buffer.from(png, 'base64'))
}
