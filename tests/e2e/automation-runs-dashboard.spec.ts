/**
 * End-to-end coverage for the Automations runs surface.
 *
 * The test intentionally does not depend on seeded run history: a fresh E2E
 * profile may have no automations, but the Runs navigation and empty state must
 * still be usable.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('opens the runs dashboard and returns to automations', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)

  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().openAutomationsPage()
  })

  const runsButton = orcaPage.getByRole('button', { name: 'Runs' })
  await expect(runsButton).toBeVisible()
  await runsButton.click()

  await expect(orcaPage.getByRole('navigation', { name: 'Automations breadcrumb' })).toBeVisible()
  await expect(orcaPage.getByText('Successful · 24h')).toBeVisible()
  await expect(orcaPage.getByText('Failed · 24h')).toBeVisible()
  await expect(orcaPage.getByText('Successful · 7d')).toBeVisible()
  await expect(orcaPage.getByText('Failed · 7d')).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Filters' })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Refresh runs' })).toBeVisible()
  await expect(orcaPage.getByText('Automation', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Triggered', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('Status', { exact: true })).toBeVisible()

  await orcaPage
    .getByRole('navigation', { name: 'Automations breadcrumb' })
    .getByRole('button', { name: 'Automations' })
    .click()
  await expect(orcaPage.getByRole('heading', { name: 'Automations' })).toBeVisible()
  await expect(runsButton).toBeVisible()
})
