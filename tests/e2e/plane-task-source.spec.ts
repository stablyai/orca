import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

/**
 * Rendered proof that the Plane task source is reachable: it appears in the
 * Tasks settings pane while disconnected (the onboarding path Jira uses), and
 * its connect dialog collects a token for Plane Cloud and additionally a base
 * URL when self-hosted.
 *
 * Assertions target the DOM rather than the store: a store round-trip would
 * pass against a provider that renders nothing.
 */
async function openTasksSettings(page: Page): Promise<void> {
  // Store-driven setup: the sidebar button never settles as "stable" under
  // headless compositing, and the pane it opens is what the test is about.
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available — build with --mode e2e')
    }
    // openSettingsPage switches the view; openSettingsTarget only records which
    // pane to land on, so both are needed.
    store.getState().openSettingsPage()
    store.getState().openSettingsTarget({ pane: 'tasks', repoId: null })
  })
}

// @headful: this spec captures the PR's visual proof, and headless Electron
// has no compositing surface to screenshot; its pane also never settles as
// "stable" for pointer actions.
test.describe('Plane task source @headful', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('is offered in Tasks settings while disconnected', async ({ orcaPage }) => {
    await openTasksSettings(orcaPage)

    // Plane follows Jira: visible while disconnected so the Tasks surface is
    // its own onboarding entry point.
    await expect(orcaPage.getByText('Plane', { exact: true }).first()).toBeVisible({
      timeout: 15_000
    })
    await expect(
      orcaPage.getByText(/Connect Plane Cloud or a self-hosted Plane instance/i)
    ).toBeVisible()
    // Disconnected state is the point: the card is offered with its setup
    // affordances rather than hidden until a token exists. Asserted through the
    // Plane-specific controls, since the status badge copy is shared by every
    // provider card.
    await expect(orcaPage.getByRole('button', { name: 'Hide Plane from Tasks' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Show Plane setup steps' })).toBeVisible()

    await orcaPage.screenshot({ path: 'test-results/plane-tasks-settings.png' })
  })

  test('connect dialog asks for a token, and for a base URL only when self-hosted', async ({
    orcaPage
  }) => {
    await openTasksSettings(orcaPage)

    const expand = orcaPage.getByRole('button', { name: 'Show Plane setup steps' })
    await expect(expand).toBeVisible({ timeout: 15_000 })
    await expand.click()

    // The step is headed "Connect Plane"; its control is "Add Plane access".
    await expect(orcaPage.getByText('Connect Plane', { exact: true })).toBeVisible()
    const connect = orcaPage.getByRole('button', { name: 'Add Plane access' })
    await expect(connect).toBeVisible({ timeout: 10_000 })
    await connect.click()

    const dialog = orcaPage.getByRole('dialog', { name: 'Connect Plane' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByLabel('Workspace slug')).toBeVisible()
    await expect(dialog.getByLabel('Personal access token')).toBeVisible()
    // Cloud needs no base URL; only a self-hosted instance does.
    await expect(dialog.getByLabel('Base URL')).toHaveCount(0)
    await orcaPage.screenshot({ path: 'test-results/plane-connect-cloud.png' })

    await dialog.getByRole('radio', { name: 'Self-hosted' }).click()
    await expect(dialog.getByLabel('Base URL')).toBeVisible()
    await orcaPage.screenshot({ path: 'test-results/plane-connect-self-hosted.png' })

    // The token must never be a plain text field.
    await expect(dialog.getByLabel('Personal access token')).toHaveAttribute('type', 'password')
  })
})
