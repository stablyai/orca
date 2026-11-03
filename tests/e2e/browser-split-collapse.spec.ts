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
    const siblingStrip = page.locator(`[data-tab-group-strip-id="${split.firstBrowserGroupId}"]`)
    const siblingRight = await siblingStrip.evaluate((el) => el.getBoundingClientRect().right)
    const { left, top, height, width } = await strip.evaluate((el) => {
      const { left, top, height, width } = el.getBoundingClientRect()
      return { left, top, height, width }
    })
    const dividerX = (siblingRight + left) / 2
    const dividerY = top + height / 2
    await page.mouse.move(dividerX, dividerY)
    await page.mouse.down()
    await page.mouse.move(dividerX - width / 4, dividerY, { steps: 5 })
    await page.mouse.up()
    const paneWidth = () => strip.evaluate((el) => el.getBoundingClientRect().width)
    const resizedWidth = await paneWidth()
    expect(resizedWidth).toBeGreaterThan(width + 1)

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
    await expect.poll(paneWidth).toBeCloseTo(resizedWidth, 1)
    expect(await guest.evaluate((webview: Electron.WebviewTag) => webview.getWebContentsId())).toBe(
      guestId
    )
    expect(await readDraft()).toBe(draft)
  } finally {
    await server.close()
  }
})
