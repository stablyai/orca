/**
 * A backdrop click in the Settings → Integrations Linear and Jira connect dialogs must
 * not close the dialog and discard typed credentials. Escape / Cancel stay the explicit discard
 * paths. (Bitbucket's baseline-seeded predicate is covered by the component tests.)
 *
 * Mirrors the SSH host form modal guard (tests/e2e/ssh-host-form-modal.spec.ts).
 */

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'

async function openIntegrationsSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host may run a non-English locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'integrations', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
}

async function clickBackdrop(page: Page): Promise<void> {
  // Why: the overlay is fixed inset-0 and the dialog sits over its center, so click near a corner.
  await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 8, y: 8 } })
}

test.describe('Settings integrations connect dialogs', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openIntegrationsSettings(orcaPage)
  })

  test('Linear API key draft survives a backdrop click but clears on cancel', async ({
    orcaPage
  }) => {
    const card = orcaPage.locator('[data-settings-section="integrations-linear"]')
    // Why: the button label depends on connection state; a fresh profile is disconnected.
    const openButton = card.getByRole('button', {
      name: /^(Add Linear access|Add workspace access)$/
    })
    await expect(openButton).toBeVisible({ timeout: 15_000 })
    await openButton.click()

    const dialog = orcaPage.getByRole('dialog', { name: 'Add Linear access' })
    await expect(dialog).toBeVisible()
    const keyInput = dialog.locator('input[type="password"]')
    await keyInput.fill('lin_api_e2e_secret')

    await clickBackdrop(orcaPage)
    // Why: assert the settled open state, not the exit-animation frame a broken guard would leave.
    await expect(dialog).toHaveAttribute('data-state', 'open')
    await expect(keyInput).toHaveValue('lin_api_e2e_secret')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Explicit cancel discards; reopening starts empty.
    await openButton.click()
    await expect(dialog.locator('input[type="password"]')).toHaveValue('')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('Jira site URL draft survives a backdrop click', async ({ orcaPage }) => {
    const card = orcaPage.locator('[data-settings-section="integrations-jira"]')
    // Why: the button label depends on connection state; a fresh profile is disconnected.
    const openButton = card.getByRole('button', { name: /^(Connect Jira|Add Jira site)$/ })
    await expect(openButton).toBeVisible({ timeout: 15_000 })
    await openButton.click()

    const dialog = orcaPage.getByRole('dialog', { name: 'Connect Jira site' })
    await expect(dialog).toBeVisible()
    const siteUrlInput = dialog.locator('input[placeholder="https://example.atlassian.net"]')
    await siteUrlInput.fill('https://acme.atlassian.net')

    await clickBackdrop(orcaPage)
    // Why: assert the settled open state, not the exit-animation frame a broken guard would leave.
    await expect(dialog).toHaveAttribute('data-state', 'open')
    await expect(siteUrlInput).toHaveValue('https://acme.atlassian.net')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })
})
