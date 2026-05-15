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
    const providerTabs = orcaPage.getByRole('group', { name: 'Usage analytics provider' })
    await expect(
      providerTabs.getByRole('button', { name: 'Overview', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(orcaPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()

    await providerTabs.getByRole('button', { name: 'Codex', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
  })
})
