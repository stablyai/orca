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
      state.openSettingsTarget({ pane: 'stats' })
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await expect(orcaPage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = orcaPage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(orcaPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await orcaPage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await orcaPage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
