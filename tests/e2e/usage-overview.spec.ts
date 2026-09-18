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
    await expect(orcaPage.getByRole('button', { name: 'Enable Devin' })).toBeVisible()

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

    await providerDropdown.click()
    await orcaPage.getByRole('menuitem', { name: 'Devin', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Devin Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Devin')
  })

  test('enabling Devin scans local transcripts and shows stats', async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await orcaPage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(orcaPage.getByTestId('usage-overview-pane')).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Enable Devin' }).click()

    const providerDropdown = orcaPage.getByTestId('usage-provider-select')
    await providerDropdown.click()
    await orcaPage.getByRole('menuitem', { name: 'Devin', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: 'Devin Usage Tracking' })).toBeVisible()

    // After enable, the pane leaves the disabled gate: the on-switch renders
    // checked and the scan settles into stats or the empty state.
    const devinSwitch = orcaPage.getByRole('switch', { name: 'Enable Devin usage analytics' })
    await expect(devinSwitch).toBeChecked({ timeout: 15_000 })

    // Wait for the scan to settle — success stamps lastScanCompletedAt, a
    // failure stamps lastScanError; either way the pane must leave loading.
    await expect
      .poll(
        async () =>
          getStoreState<{
            lastScanCompletedAt: number | null
            lastScanError: string | null
          }>(orcaPage, 'devinUsageScanState'),
        { timeout: 15_000 }
      )
      .not.toEqual(
        expect.objectContaining({
          lastScanCompletedAt: null,
          lastScanError: null
        })
      )

    await expect(
      orcaPage.getByText(/Input tokens|No local Devin usage found yet|Last scan error/).first()
    ).toBeVisible()
  })
})
