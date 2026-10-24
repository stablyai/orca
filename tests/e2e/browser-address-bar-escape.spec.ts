import { expect, test } from './helpers/orca-app'
import type { Locator, Page } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  getActiveTabType,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './helpers/browser-split-page-server'

type AddressBarFocus = { value: string; focused: boolean; start: number | null; end: number | null }

function addressBarInput(page: Page): Locator {
  return page.locator('[data-orca-browser-address-bar="true"]')
}

async function readAddressBar(page: Page): Promise<AddressBarFocus> {
  return addressBarInput(page).evaluate((input: HTMLInputElement) => {
    return {
      value: input.value,
      focused: document.activeElement === input,
      start: input.selectionStart,
      end: input.selectionEnd
    }
  })
}

function suggestionRows(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option')
}

async function activeElementTag(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? null)
}

async function openPageTab(page: Page, pageUrl: string): Promise<void> {
  const worktreeId = (await getActiveWorktreeId(page))!
  await page.evaluate(
    ({ targetWorktreeId, url }) => {
      window.__store?.getState().createBrowserTab(targetWorktreeId, url, {
        title: 'Escape ladder page',
        activate: true
      })
    },
    { targetWorktreeId: worktreeId, url: pageUrl }
  )
  await expect.poll(async () => getActiveTabType(page), { timeout: 10_000 }).toBe('browser')
  await expect(addressBarInput(page)).toHaveValue(pageUrl, { timeout: 15_000 })
}

async function focusAddressBar(page: Page): Promise<void> {
  await addressBarInput(page).focus()
  await expect.poll(async () => (await readAddressBar(page)).focused).toBe(true)
}

async function pressEscape(page: Page): Promise<void> {
  // Why keyboard, not locator.press: locator.press refocuses the input, which reselects and reopens.
  await page.keyboard.press('Escape')
}

async function expectRevertedToPage(page: Page, pageUrl: string): Promise<void> {
  await expect
    .poll(() => readAddressBar(page))
    .toEqual({ value: pageUrl, focused: true, start: 0, end: pageUrl.length })
}

async function expectFocusLeftForPage(page: Page, pageUrl: string): Promise<void> {
  await expect.poll(() => activeElementTag(page)).toBe('webview')
  await expect(addressBarInput(page)).toHaveValue(pageUrl)
}

test.describe('Browser address bar Escape', () => {
  let server: BrowserSplitPageServer

  test.beforeEach(async ({ orcaPage }) => {
    server = await startBrowserSplitPageServer()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async () => {
    await server.close()
  })

  test('an edit with no dropdown rows reverts with the dropdown closed, then leaves', async ({
    orcaPage
  }) => {
    const pageUrl = server.pageUrl('escape', 1)
    await openPageTab(orcaPage, pageUrl)
    await focusAddressBar(orcaPage)
    await orcaPage.keyboard.type('javascript:void')
    await expect(addressBarInput(orcaPage)).toHaveValue('javascript:void')
    await expect(suggestionRows(orcaPage)).toHaveCount(0)

    await pressEscape(orcaPage)
    await expectRevertedToPage(orcaPage, pageUrl)
    await expect(suggestionRows(orcaPage)).toHaveCount(0)

    await pressEscape(orcaPage)
    await expectFocusLeftForPage(orcaPage, pageUrl)
  })

  test('an edit with the dropdown open closes, keeps the text, reverts, then leaves', async ({
    orcaPage
  }, testInfo) => {
    const pageUrl = server.pageUrl('escape', 1)
    await openPageTab(orcaPage, pageUrl)
    await focusAddressBar(orcaPage)
    await orcaPage.keyboard.type('ladder')
    await expect(addressBarInput(orcaPage)).toHaveAttribute('aria-expanded', 'true')
    await expect(suggestionRows(orcaPage).first()).toBeVisible()

    await pressEscape(orcaPage)
    await expect(addressBarInput(orcaPage)).toHaveAttribute('aria-expanded', 'false')
    await expect(suggestionRows(orcaPage)).toHaveCount(0)
    await expect
      .poll(() => readAddressBar(orcaPage))
      .toMatchObject({ value: 'ladder', focused: true })

    await pressEscape(orcaPage)
    await expectRevertedToPage(orcaPage, pageUrl)
    await expect(suggestionRows(orcaPage)).toHaveCount(0)
    const screenshotPath = testInfo.outputPath('after-revert.png')
    await orcaPage.screenshot({ path: screenshotPath })
    await testInfo.attach('after-revert', { path: screenshotPath, contentType: 'image/png' })

    await pressEscape(orcaPage)
    await expectFocusLeftForPage(orcaPage, pageUrl)
  })

  test('an arrowed suggestion restores the typed query with the dropdown still open', async ({
    orcaPage
  }) => {
    const pageUrl = server.pageUrl('escape', 1)
    const historyUrl = server.pageUrl('ladder', 2)
    await orcaPage.evaluate((url) => {
      window.__store?.getState().addBrowserHistoryEntry(url, 'ladder 2')
    }, historyUrl)
    await openPageTab(orcaPage, pageUrl)
    await focusAddressBar(orcaPage)
    await orcaPage.keyboard.type('ladder')
    await expect(suggestionRows(orcaPage).filter({ hasText: historyUrl })).toBeVisible()

    await orcaPage.keyboard.press('ArrowDown')
    await expect(addressBarInput(orcaPage)).toHaveValue(historyUrl)

    await pressEscape(orcaPage)
    await expect
      .poll(() => readAddressBar(orcaPage))
      .toEqual({ value: 'ladder', focused: true, start: 6, end: 6 })
    await expect(suggestionRows(orcaPage).filter({ hasText: historyUrl })).toBeVisible()

    await pressEscape(orcaPage)
    await expect(addressBarInput(orcaPage)).toHaveAttribute('aria-expanded', 'false')
    await expect(addressBarInput(orcaPage)).toHaveValue('ladder')

    await pressEscape(orcaPage)
    await expectRevertedToPage(orcaPage, pageUrl)

    await pressEscape(orcaPage)
    await expectFocusLeftForPage(orcaPage, pageUrl)
  })

  test('an unedited bar with no dropdown leaves for the page on one press', async ({
    orcaPage
  }) => {
    const pageUrl = server.pageUrl('escape', 1)
    await openPageTab(orcaPage, pageUrl)
    await focusAddressBar(orcaPage)
    await expect(suggestionRows(orcaPage).first()).toBeVisible()
    await pressEscape(orcaPage)
    await expect(addressBarInput(orcaPage)).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await readAddressBar(orcaPage)).focused).toBe(true)

    await pressEscape(orcaPage)
    await expectFocusLeftForPage(orcaPage, pageUrl)
  })
})
