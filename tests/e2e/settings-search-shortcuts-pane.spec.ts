import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.describe('Settings sidebar search on the Shortcuts pane', () => {
  test('picking a result opens the Shortcuts pane unfiltered with local search usable', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Pin English instead of following the host locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openSettingsPage()
    })

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()
    await searchInput.fill('shortcuts')

    // Typing only lists results; the page moves on an explicit pick.
    await expect(orcaPage.getByRole('option').first()).toBeVisible()
    await expect(
      orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })
    ).not.toBeVisible()
    await searchInput.press('ArrowDown')
    await searchInput.press('Enter')
    await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()

    // The sidebar query no longer filters the pane, so every row and the pane's own search stay usable.
    await expect(orcaPage.getByText('Go to file', { exact: true })).toBeVisible()
    await expect(searchInput).toHaveValue('shortcuts')
    const localSearch = orcaPage.getByPlaceholder('Search command or keys')
    await localSearch.fill('go to')
    await expect(orcaPage.getByText('Go to file', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Force reload', { exact: true })).not.toBeVisible()
  })
})
