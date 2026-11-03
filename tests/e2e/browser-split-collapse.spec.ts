import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  browserOverlay,
  createBrowserSplit,
  shortcutModifier
} from './helpers/browser-split-fixture'
import { waitForGuestUrl } from './helpers/browser-split-guest-probes'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'

test('collapsing a browser split moves Find to its sibling and preserves the draft on expand', async ({
  orcaPage: page
}) => {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await page.evaluate(async () => {
    await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
  })
  const server = await startBrowserSplitPageServer()
  try {
    const draftUrl = server.pageUrl('draft', 1)
    const split = await createBrowserSplit(page, {
      first: server.pageUrl('preview', 1),
      second: draftUrl
    })
    await waitForGuestUrl(page, split.secondBrowserTabId, draftUrl)
    const guest = browserOverlay(page, split.secondBrowserTabId).locator('webview')
    const draft = 'Keep this unsaved note.'
    const guestId = await guest.evaluate(async (webview: Electron.WebviewTag, text) => {
      await webview.executeJavaScript('document.querySelector("textarea").focus()')
      await webview.insertText(text)
      return webview.getWebContentsId()
    }, draft)
    const readDraft = () =>
      guest.evaluate((webview: Electron.WebviewTag) =>
        webview.executeJavaScript('document.querySelector("textarea").value')
      )
    expect(await readDraft()).toBe(draft)

    const strip = page.locator(`[data-tab-group-strip-id="${split.secondBrowserGroupId}"]`)
    await strip.getByRole('button', { name: 'Collapse webpage' }).click()
    const expand = page.getByRole('button', { name: 'Expand webpage' })
    await expect(expand).toBeVisible()
    await page.keyboard.press(`${shortcutModifier}+f`)
    const siblingFind = browserOverlay(page, split.firstBrowserTabId).getByPlaceholder(
      'Find in page...'
    )
    await expect(siblingFind).toBeFocused()
    await page.keyboard.press('Escape')

    await expand.click()
    await expect(strip.getByRole('button', { name: 'Collapse webpage' })).toBeVisible()
    expect(await guest.evaluate((webview: Electron.WebviewTag) => webview.getWebContentsId())).toBe(
      guestId
    )
    expect(await readDraft()).toBe(draft)
  } finally {
    await server.close()
  }
})
