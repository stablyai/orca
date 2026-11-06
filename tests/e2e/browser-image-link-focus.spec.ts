import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { startBrowserLinkServer } from './helpers/browser-link-server'
import { getActiveWorktreeId } from './helpers/store'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test.describe('Image link focus', () => {
  test.skip(
    process.platform !== 'linux' ||
      process.env.ORCA_E2E_BROWSER_NATIVE_XVFB !== '1' ||
      (process.env.GITHUB_ACTIONS !== 'true' && !existsSync('/.dockerenv')),
    'Native input requires the owned CI or Docker Xvfb display'
  )

  test('routes native Ctrl+W to the image tab and preserves the opener @headful', async ({
    orcaPage,
    electronApp
  }) => {
    const ownedWindow = await electronApp.browserWindow(orcaPage)
    let nativeWindowId: number
    try {
      nativeWindowId = await ownedWindow.evaluate((window) => {
        if (
          process.platform !== 'linux' ||
          process.env.ORCA_BACKGROUND_LAUNCH !== '1' ||
          process.env.ORCA_E2E_BROWSER_NATIVE_XVFB !== '1' ||
          !/^:\d+(?:\.\d+)?$/.test(process.env.DISPLAY ?? '') ||
          (process.env.GITHUB_ACTIONS !== 'true' &&
            !process.getBuiltinModule('node:fs').existsSync('/.dockerenv')) ||
          window.isDestroyed()
        ) {
          throw new Error('Native browser input requires an owned CI or Docker Xvfb window')
        }
        window.showInactive()
        return window.getNativeWindowHandle().readUInt32LE(0)
      })
      await expect.poll(() => ownedWindow.evaluate((window) => window.isVisible())).toBe(true)
    } finally {
      await ownedWindow.dispose()
    }
    await orcaPage.waitForFunction(() => document.visibilityState === 'visible')
    const nativeInput = (...args: string[]): void => {
      execFileSync('xdotool', args, { stdio: 'pipe', timeout: 10_000 })
    }
    nativeInput('windowactivate', '--sync', String(nativeWindowId))
    const fixture = await startBrowserLinkServer()
    try {
      const worktreeId = (await getActiveWorktreeId(orcaPage))!
      const sourceTabId = await orcaPage.evaluate(
        ({ worktreeId, url }) =>
          window.__store!.getState().createBrowserTab(worktreeId, url, { activate: true }).id,
        { worktreeId, url: fixture.imageSourceUrl }
      )
      const sourceTab = orcaPage.locator(`[data-tab-id="${sourceTabId}"]`)
      const sourceOverlay = orcaPage.locator(`[data-browser-overlay-tab-id="${sourceTabId}"]`)
      const sourceWebview = sourceOverlay.locator('webview')
      await expect(sourceTab).toContainText('Image gallery')
      await expect(sourceWebview).toBeVisible()
      const point = await sourceWebview.evaluate(async (webview: Electron.WebviewTag) => {
        const point: unknown = await webview.executeJavaScript(`(() => {
          const image = document.querySelector('#linked-image')
          const rect = image.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        })()`)
        if (
          typeof point !== 'object' ||
          point === null ||
          !('x' in point) ||
          typeof point.x !== 'number' ||
          !('y' in point) ||
          typeof point.y !== 'number'
        ) {
          throw new Error('The linked image has no click coordinates')
        }
        return { x: point.x, y: point.y }
      })
      const bounds = await sourceWebview.boundingBox()
      if (!bounds) {
        throw new Error('The source image webview has no visible bounds')
      }
      await sourceWebview.evaluate((webview: Electron.WebviewTag) =>
        webview.executeJavaScript(`window.addEventListener('keydown', event => {
          if (event.key === 'y') document.documentElement.dataset.nativeKeySeen = 'y'
        }); true`)
      )
      nativeInput(
        'mousemove',
        '--window',
        String(nativeWindowId),
        String(Math.round(bounds.x + 10)),
        String(Math.round(bounds.y + 10))
      )
      nativeInput('click', '1')
      nativeInput('key', 'y')
      await expect
        .poll(() =>
          sourceWebview.evaluate((webview: Electron.WebviewTag) =>
            webview.executeJavaScript(`document.documentElement.dataset.nativeKeySeen === 'y'`)
          )
        )
        .toBe(true)
      nativeInput(
        'mousemove',
        '--window',
        String(nativeWindowId),
        String(Math.round(bounds.x + point.x)),
        String(Math.round(bounds.y + point.y))
      )
      nativeInput('click', '1')

      const destinationTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'image.png' })
      await expect(destinationTab).toBeVisible()
      const destinationTabId = await destinationTab.getAttribute('data-tab-id')
      const destinationOverlay = orcaPage.locator(
        `[data-browser-overlay-tab-id="${destinationTabId}"]`
      )
      await expect(destinationOverlay).toHaveCSS('opacity', '1')
      const destinationWebview = destinationOverlay.locator('webview')
      await expect
        .poll(() =>
          destinationWebview.evaluate((webview: Electron.WebviewTag) =>
            webview.executeJavaScript(`(() => {
              const image = document.images[0]
              return document.contentType === 'image/png' && image?.complete && image.naturalWidth > 0
            })()`)
          )
        )
        .toBe(true)
      await expect(destinationWebview).toBeFocused()
      nativeInput('key', '--clearmodifiers', 'ctrl+w')

      await expect(destinationTab).toHaveCount(0)
      await expect(sourceTab).toBeVisible()
      await expect(sourceOverlay).toHaveCSS('opacity', '1')
      await expect
        .poll(() => sourceWebview.evaluate((webview: Electron.WebviewTag) => webview.getURL()))
        .toBe(fixture.imageSourceUrl)
    } finally {
      await fixture.close()
    }
  })
})
