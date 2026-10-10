/**
 * Settings search end-to-end: filtering the sidebar, navigating to a matched
 * result, and clearing the filter.
 *
 * Drives the real search Input and nav buttons so a render-layer regression —
 * a filtered list that paints blank, a click that leaves the query applied, or
 * a clear that fails to restore sections — fails here instead of only in the
 * search-ranking unit tests.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: scope to the settings nav scroller so the Back button and the onboarding
// row outside it are excluded from visibility checks and counts.
function navList(page: Page) {
  return page.locator('.settings-view-shell aside .overflow-y-auto')
}

function navButton(page: Page, name: string) {
  return navList(page).getByRole('button', { name })
}

function navButtonCount(page: Page): Promise<number> {
  return navList(page).getByRole('button').count()
}

function appliedSettingsQuery(page: Page): Promise<string> {
  return page.evaluate(() => window.__store?.getState().settingsSearchQuery ?? '')
}

async function openSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store!
    // Why: the spec asserts on English labels; the host locale may not be English.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({
    timeout: 10_000
  })
}

async function searchSettings(page: Page, query: string): Promise<void> {
  await page.getByPlaceholder('Search settings').fill(query)
  // Why: the applied filter debounces ~150ms behind the input value.
  await expect
    .poll(() => appliedSettingsQuery(page), {
      timeout: 5_000,
      message: `settings search query did not apply: ${query}`
    })
    .toBe(query)
}

test.describe('Settings search navigation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('filters the sidebar to matches and reveals the matching pane', async ({ orcaPage }) => {
    await openSettings(orcaPage)
    const fullCount = await navButtonCount(orcaPage)

    await searchSettings(orcaPage, 'Quick Commands')

    expect(await appliedSettingsQuery(orcaPage)).toBe('Quick Commands')
    await expect(navButton(orcaPage, 'Quick Commands')).toBeVisible()
    await expect(navButton(orcaPage, 'Appearance')).not.toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Quick Commands' }).first()).toBeVisible()
    await expect(orcaPage.locator('[data-settings-section="quick-commands"]')).toBeVisible()
    await expect.poll(() => navButtonCount(orcaPage)).toBeLessThan(fullCount)
  })

  test('clicking a search result navigates to the owning pane and clears the query', async ({
    orcaPage
  }) => {
    await openSettings(orcaPage)
    // "git" matches the Git section (which auto-activates) and Appearance (via its
    // "Show Git-Ignored Files" row), giving us a non-active result to click.
    await searchSettings(orcaPage, 'git')

    const result = navButton(orcaPage, 'Appearance')
    await expect(result).toBeVisible()
    // The matched result is listed but not yet the open pane.
    await expect(orcaPage.locator('[data-settings-section="appearance"]')).not.toBeVisible()

    await result.click()

    await expect(orcaPage.getByPlaceholder('Search settings')).toHaveValue('')
    await expect.poll(() => appliedSettingsQuery(orcaPage)).toBe('')
    await expect(orcaPage.locator('[data-settings-section="appearance"]')).toBeVisible()
  })

  test('clearing the search restores the full section list', async ({ orcaPage }) => {
    await openSettings(orcaPage)
    const fullCount = await navButtonCount(orcaPage)
    await expect(navButton(orcaPage, 'Appearance')).toBeVisible()

    await searchSettings(orcaPage, 'Quick Commands')
    await expect(navButton(orcaPage, 'Appearance')).not.toBeVisible()
    await expect.poll(() => navButtonCount(orcaPage)).toBeLessThan(fullCount)

    await orcaPage.getByPlaceholder('Search settings').fill('')
    await expect.poll(() => appliedSettingsQuery(orcaPage)).toBe('')

    await expect(navButton(orcaPage, 'Appearance')).toBeVisible()
    await expect(navButton(orcaPage, 'Quick Commands')).toBeVisible()
    await expect.poll(() => navButtonCount(orcaPage)).toBe(fullCount)
  })

  test('clearing the search with the keyboard dismisses results without closing Settings', async ({
    orcaPage
  }) => {
    await openSettings(orcaPage)
    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await searchSettings(orcaPage, 'Quick Commands')
    await expect(navButton(orcaPage, 'Appearance')).not.toBeVisible()

    await searchInput.focus()
    await expect(searchInput).toBeFocused()
    // Why: Escape is bound to closing Settings on non-Shortcuts panes, so the
    // supported "dismiss results" gesture here is clearing the field by keyboard.
    await searchInput.press('ControlOrMeta+a')
    await searchInput.press('Backspace')

    await expect(searchInput).toHaveValue('')
    await expect.poll(() => appliedSettingsQuery(orcaPage)).toBe('')
    // Settings stays mounted and the full list comes back.
    await expect(searchInput).toBeVisible()
    await expect(navButton(orcaPage, 'Appearance')).toBeVisible()
  })

  test('a subsection-only query reveals the parent pane and the subsection', async ({
    orcaPage
  }) => {
    await openSettings(orcaPage)
    // "Font Ligatures" is indexed only under Appearance > Terminal Typography.
    await searchSettings(orcaPage, 'Font Ligatures')

    await expect(navButton(orcaPage, 'Appearance')).toBeVisible()
    await expect(orcaPage.locator('[data-settings-section="appearance"]')).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Terminal Typography' })).toBeVisible()
    await expect(orcaPage.getByText('Font Ligatures').first()).toBeVisible()
  })
})
