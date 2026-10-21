import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { expect, type Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'

// Hold the response, not a timer: every screenshot precedes the first document commit.
export async function observeBrowserLoadingSurface(
  page: Page,
  outputPath: (name: string) => string,
  crashGuest?: (id: number) => Promise<void>
) {
  const pendingResponses: (() => void)[] = []
  const release = (): void => {
    pendingResponses.splice(0).forEach((send) => send())
  }
  let requestCount = 0
  let flushPrefix: (() => void) | undefined
  let retryReady = false
  const server = createServer((request, response) => {
    if (request.url === '/fail' && !retryReady) {
      response.destroy()
      return
    }
    if (request.url !== '/held' && request.url !== '/fail') {
      response.writeHead(204).end()
      return
    }
    requestCount += 1
    let prefixSent = false
    flushPrefix = () => {
      prefixSent = true
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.write(
        `<!doctype html><head><title>Surface oracle</title></head><!--${'.'.repeat(4096)}-->`
      )
    }
    pendingResponses.push(() =>
      response.end(
        `${prefixSent ? '' : '<!doctype html><title>Surface oracle</title>'}<body><h1>Usable webpage</h1><input value="retained"></body>`
      )
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/held`
  const observations: Record<string, unknown>[] = []
  // Freezing attachment for a screenshot must also freeze the missing-guest watchdog.
  await page.clock.pauseAt(new Date())
  const attachGate = await page.evaluateHandle((heldUrl) => {
    const original = Element.prototype.setAttribute
    const pending: (() => void)[] = []
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === 'WEBVIEW' && name === 'src' && value === heldUrl) {
        pending.push(() => original.call(this, name, value))
        return
      }
      original.call(this, name, value)
    }
    return () => {
      Element.prototype.setAttribute = original
      pending.splice(0).forEach((release) => release())
    }
  }, url)
  try {
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
    const tab = await page.evaluate((url) => {
      const s = window.__store!.getState()
      return s.createBrowserTab(s.activeWorktreeId!, url, {
        activate: true,
        title: 'Surface oracle'
      })
    }, url)
    let guest = page.locator(`[data-browser-overlay-tab-id="${tab.id}"] webview`)
    await expect(guest).toHaveCount(1)
    const capture = async (phase: string, expected: 'theme' | 'white', loading = false) => {
      const state = await guest.evaluate((element) => {
        const webview = element as Electron.WebviewTag
        const rect = webview.closest('[data-browser-page-container]')!.getBoundingClientRect()
        let loading = false
        let url = ''
        let attached = false
        try {
          loading = webview.isLoading()
          url = webview.getURL()
          attached = webview.getWebContentsId() > 0
        } catch {
          /* Guest creation is held by the oracle. */
        }
        return {
          attached,
          background: getComputedStyle(webview).backgroundColor,
          theme: getComputedStyle(webview.closest('[data-browser-page-container]')!)
            .backgroundColor,
          visibility: getComputedStyle(webview).visibility,
          display: getComputedStyle(webview).display,
          loading,
          url,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
      })
      const target =
        expected === 'white' ? [255, 255, 255] : state.theme.match(/\d+/g)!.slice(0, 3).map(Number)
      let samples: number[][] = []
      const sampleSurface = async (): Promise<boolean> => {
        const screenshot = await page.screenshot({ path: outputPath(`${phase}.png`), scale: 'css' })
        const png = PNG.sync.read(screenshot)
        samples = [0.08, 0.92].flatMap((x) =>
          [0.08, 0.85, 0.92].map((y) => {
            const offset =
              (Math.floor(state.rect.y + state.rect.height * y) * png.width +
                Math.floor(state.rect.x + state.rect.width * x)) *
              4
            return [...png.data.subarray(offset, offset + 3)]
          })
        )
        return samples.every((rgb) => rgb.every((c, i) => Math.abs(c - target[i]) <= 2))
      }
      let pixelPass = await sampleSurface()
      if (expected === 'white' && !pixelPass) {
        // Loading can stop before the compositor presents the recovered guest's first frame.
        await expect.poll(async () => (pixelPass = await sampleSurface())).toBe(true)
      }
      const statePass =
        expected === 'theme'
          ? state.background === state.theme ||
            state.visibility === 'hidden' ||
            state.display === 'none'
          : state.url.startsWith('http://127.0.0.1:')
      expect(state.loading).toBe(loading)
      observations.push({
        phase,
        ...state,
        samples,
        pixelPass,
        statePass,
        pass: pixelPass && statePass
      })
    }
    const dismissDrawHint = page.getByRole('button', { name: 'Got it', exact: true })
    if (await dismissDrawHint.isVisible()) {
      await dismissDrawHint.click()
      await expect(dismissDrawHint).not.toBeVisible()
    }
    await page.keyboard.press('Escape')
    await page.mouse.move(0, 0)
    await capture('pre-attach', 'theme')
    await attachGate.evaluate((release) => release())
    await page.clock.resume()
    await expect.poll(() => requestCount).toBe(1)
    await capture('dark-held', 'theme', true)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'light' })
    })
    await expect(page.locator('html')).toHaveClass(/light/)
    await capture('light-held', 'theme', true)
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await capture('dark-again-held', 'theme', true)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'system' })
    })
    await expect(page.locator('html')).toHaveClass(/light/)
    await capture('system-light-held', 'theme', true)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/dark/)
    await capture('system-dark-held', 'theme', true)
    await page.emulateMedia({ colorScheme: null })
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
    })
    flushPrefix!()
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).getTitle()))
      .toBe('Surface oracle')
    await capture('committed-empty', 'theme', true)
    release!()
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
      .toBe(false)
    expect(
      await guest.evaluate((e) =>
        (e as Electron.WebviewTag).executeJavaScript(
          '({ text: document.querySelector("h1").textContent, style: document.body.getAttribute("style") })'
        )
      )
    ).toEqual({ text: 'Usable webpage', style: null })
    await capture('unstyled-painted', 'white')
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'light' })
    })
    await expect(page.locator('html')).toHaveClass(/light/)
    await capture('unstyled-light', 'white')
    await page.evaluate(async () => {
      await window.__store!.getState().updateSettingsOrThrow({ theme: 'dark' })
    })
    await expect(page.locator('html')).toHaveClass(/dark/)
    const pane = page.locator(`[data-browser-overlay-tab-id="${tab.id}"]`)
    await pane.getByRole('button', { name: 'Reload', exact: true }).click()
    await expect.poll(() => requestCount).toBe(2)
    await capture('reload-retained', 'white', true)
    release!()
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
      .toBe(false)
    const guestId = await guest.evaluate((e) => (e as Electron.WebviewTag).getWebContentsId())
    const worktreeId = await page.evaluate(() => window.__store!.getState().activeWorktreeId!)
    await page.evaluate(() => window.__store!.getState().setActiveWorktree(null))
    await expect(pane).not.toBeVisible()
    await page.evaluate(
      ({ worktreeId, tabId }) => {
        const s = window.__store!.getState()
        s.setActiveWorktree(worktreeId)
        s.setActiveBrowserTab(tabId)
      },
      { worktreeId, tabId: tab.id }
    )
    await expect(pane).toBeVisible()
    expect(await guest.evaluate((e) => (e as Electron.WebviewTag).getWebContentsId())).toBe(guestId)
    await capture('unpark-retained', 'white')
    if (crashGuest) {
      await crashGuest(guestId)
      await expect.poll(() => requestCount).toBe(3)
      await capture('recovery-held', 'theme', true)
      release!()
      await expect
        .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
        .toBe(false)
      await capture('recovery-painted', 'white')
    }
    const blank = await page.evaluate(() => {
      const s = window.__store!.getState()
      return s.createBrowserTab(s.activeWorktreeId!, 'about:blank', { activate: true })
    })
    guest = page.locator(`[data-browser-overlay-tab-id="${blank.id}"] webview`)
    await expect
      .poll(() =>
        guest.evaluate((e) => {
          try {
            return (e as Electron.WebviewTag).getURL()
          } catch {
            return ''
          }
        })
      )
      .toMatch(/about:blank|data:text\/html,/)
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
      .toBe(false)
    await page.keyboard.press('Escape')
    await capture('new-tab', 'theme')
    // Navigate through the real address input, retaining the blank document while the server waits.
    const address = page.locator(`[data-browser-overlay-tab-id="${blank.id}"] input`).first()
    await address.fill(url)
    await address.press('Enter')
    await expect.poll(() => requestCount).toBe(crashGuest ? 4 : 3)
    await capture('new-tab-first-navigation-held', 'theme', true)
    release!()
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
      .toBe(false)
    await capture('new-tab-painted', 'white')
    await address.fill(url.replace('/held', '/fail'))
    await address.press('Enter')
    const retry = page
      .locator(`[data-browser-overlay-tab-id="${blank.id}"]`)
      .getByRole('button', { name: 'Retry', exact: true })
      .filter({ hasText: 'Retry' })
    await expect(retry).toBeVisible()
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
      .toBe(false)
    await capture('network-error', 'theme')
    retryReady = true
    const countBeforeRetry = requestCount
    await retry.click()
    await expect.poll(() => requestCount).toBeGreaterThan(countBeforeRetry)
    await capture('network-retry-held', 'theme', true)
    release!()
    await expect(retry).not.toBeVisible()
    await expect
      .poll(() => guest.evaluate((e) => (e as Electron.WebviewTag).isLoading()))
      .toBe(false)
    await capture('network-retry-painted', 'white')
    await writeFile(outputPath('observations.json'), JSON.stringify(observations, null, 2))
    return observations
  } finally {
    await attachGate.evaluate((release) => release()).catch(() => {})
    await page.clock.resume().catch(() => {})
    await attachGate.dispose()
    release?.()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
