import { test, expect } from './helpers/mcode-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    mcodePage
  }) => {
    await mcodePage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(mcodePage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await mcodePage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(mcodePage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = mcodePage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(mcodePage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(mcodePage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(mcodePage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(mcodePage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(mcodePage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(mcodePage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await mcodePage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(mcodePage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await mcodePage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(mcodePage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
