import { test, expect } from './helpers/orca-app'
import { startBrowserLinkServer } from './helpers/browser-link-server'
import { getActiveWorktreeId } from './helpers/store'

test.describe('Image link focus', () => {
  test('CmdOrCtrl+W closes the image destination and preserves its opener', async ({
    orcaPage
  }) => {
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
        return (await webview.executeJavaScript(`(() => {
          const image = document.querySelector('#linked-image')
          const rect = image.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        })()`)) as { x: number; y: number }
      })
      const bounds = await sourceWebview.boundingBox()
      if (!bounds) {
        throw new Error('The source image webview has no visible bounds')
      }
      await orcaPage.mouse.click(bounds.x + point.x, bounds.y + point.y)

      const destinationTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'image.png' })
      await expect(destinationTab).toBeVisible()
      const destinationTabId = await destinationTab.getAttribute('data-tab-id')
      const destinationOverlay = orcaPage.locator(
        `[data-browser-overlay-tab-id="${destinationTabId}"]`
      )
      await expect(destinationOverlay).toHaveCSS('opacity', '1')
      await expect(destinationOverlay.locator('webview')).toBeFocused()
      // Top-level CDP keyboard input does not enter a webview; use the DOM-focused guest.
      await orcaPage.evaluate((isMac) => {
        const webview = document.activeElement as Electron.WebviewTag
        webview.sendInputEvent({
          type: 'keyDown',
          keyCode: 'W',
          modifiers: [isMac ? 'meta' : 'control']
        })
        webview.sendInputEvent({
          type: 'keyUp',
          keyCode: 'W',
          modifiers: [isMac ? 'meta' : 'control']
        })
      }, process.platform === 'darwin')

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
