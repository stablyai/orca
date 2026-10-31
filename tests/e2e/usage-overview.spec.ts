import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    orcaPage
  }) => {
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await orcaPage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(orcaPage.getByRole('heading', { name: 'History detail' })).toBeVisible()
    const providerDropdown = orcaPage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(orcaPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Historical usage' })).toBeVisible()
    await expect(orcaPage.getByTestId('usage-history-totals')).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Refresh historical usage' })).toBeVisible()

    await providerDropdown.click()
    await orcaPage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Historical usage' })).toBeVisible()
    const originalView = orcaPage.locator('summary', { hasText: 'Original provider view' })
    await originalView.click()
    await expect(orcaPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await originalView.click()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await orcaPage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Historical usage' })).toBeVisible()
    await originalView.click()
    await expect(orcaPage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
