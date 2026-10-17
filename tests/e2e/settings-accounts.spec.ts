/**
 * Settings → Accounts pane E2E.
 *
 * Covers the provider sections the pane actually renders. Grounded in
 * AccountsPane.tsx: on every desktop platform it renders Claude (#accounts-claude),
 * Codex (#accounts-codex), Gemini CLI legacy (#accounts-gemini), Antigravity
 * (#accounts-antigravity), OpenCode Go (#accounts-opencode-go), MiniMax
 * (#accounts-minimax), Grok (#accounts-grok), Cursor (#accounts-cursor) and GLM
 * Coding Plan (#accounts-zcode). The WSL-only Account Location section
 * (#accounts-runtime) is intentionally not asserted because it is platform-gated.
 *
 * Also covers the global Settings search narrowing the pane and its sub-settings,
 * a sign-in affordance flow that opens without launching a real provider login,
 * and the empty/disconnected states a fresh profile shows.
 *
 * Assertions target the DOM; the store is only used to open Settings on the
 * accounts pane.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'

/** Open Settings directly on the Accounts pane (the real deep-link entry point). */
async function openAccountsSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host may run a non-English locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'accounts', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({
    timeout: 10_000
  })
  await dismissTransientAnnouncement(page)
}

/** The active Accounts SettingsSection, which owns every provider section. */
function accountsPane(page: Page) {
  return page.locator('section.scroll-mt-8[data-settings-section="accounts"]')
}

/** A provider section rendered inside the Accounts pane, by its source `id`. */
function accountSection(page: Page, id: string) {
  return accountsPane(page).locator(`#${id}`)
}

const PROVIDER_SECTIONS = [
  { id: 'accounts-claude', heading: 'Claude' },
  { id: 'accounts-codex', heading: 'Codex' },
  { id: 'accounts-gemini', heading: 'Gemini CLI (legacy)' },
  { id: 'accounts-antigravity', heading: 'Antigravity' },
  { id: 'accounts-opencode-go', heading: 'OpenCode Go' },
  { id: 'accounts-minimax', heading: 'MiniMax' },
  { id: 'accounts-grok', heading: 'Grok (xAI)' },
  { id: 'accounts-cursor', heading: 'Cursor' },
  { id: 'accounts-zcode', heading: 'GLM Coding Plan' }
] as const

test.describe('Settings accounts pane', () => {
  test('renders the provider account sections with their rows and labels', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openAccountsSettings(orcaPage)

    const pane = accountsPane(orcaPage)
    await expect(pane).toBeVisible({ timeout: 15_000 })
    await expect(pane.getByRole('heading', { name: 'AI Provider Accounts' })).toBeVisible()

    for (const { id, heading } of PROVIDER_SECTIONS) {
      const section = accountSection(orcaPage, id)
      await expect(section).toBeVisible({ timeout: 15_000 })
      await expect(section.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    }

    // Claude and Codex expose a "System default" row plus the Add Account control.
    for (const id of ['accounts-claude', 'accounts-codex'] as const) {
      const section = accountSection(orcaPage, id)
      // Scope to the account row button: the empty state also mentions "system default".
      await expect(section.getByRole('button', { name: 'System default' })).toBeVisible()
      await expect(section.getByRole('button', { name: 'Add Account' })).toBeVisible()
    }

    // OpenCode Go renders its two distinct sub-settings.
    const openCode = accountSection(orcaPage, 'accounts-opencode-go')
    await expect(openCode.getByText('OpenCode Go session cookie')).toBeVisible()
    await expect(openCode.getByText('Workspace ID override')).toBeVisible()
  })

  test('searching a provider term narrows the pane, and a sub-setting term filters rows', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await openAccountsSettings(orcaPage)

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await searchInput.fill('minimax')

    // The pane stays mounted and only the matching provider section survives.
    await expect(accountsPane(orcaPage)).toBeVisible({ timeout: 10_000 })
    await expect(accountSection(orcaPage, 'accounts-minimax')).toBeVisible({
      timeout: 10_000
    })
    await expect(accountSection(orcaPage, 'accounts-claude')).toBeHidden()
    await expect(accountSection(orcaPage, 'accounts-codex')).toBeHidden()
    await expect(accountSection(orcaPage, 'accounts-cursor')).toBeHidden()

    // A sub-setting term keeps only the matching row inside its own section.
    await searchInput.fill('workspace')
    const openCode = accountSection(orcaPage, 'accounts-opencode-go')
    await expect(openCode).toBeVisible({ timeout: 10_000 })
    await expect(openCode.getByText('Workspace ID override')).toBeVisible()
    await expect(openCode.getByText('OpenCode Go session cookie')).toBeHidden()
    // Unrelated provider sections are filtered out entirely.
    await expect(accountSection(orcaPage, 'accounts-minimax')).toBeHidden()
    await expect(accountSection(orcaPage, 'accounts-claude')).toBeHidden()
  })

  test('account sign-in affordances are enabled and a flow opens without launching a login', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await openAccountsSettings(orcaPage)

    // Per-section add/sign-in affordances are present and enabled on a local profile.
    await expect(
      accountSection(orcaPage, 'accounts-claude').getByRole('button', {
        name: 'Add Account'
      })
    ).toBeEnabled()
    await expect(
      accountSection(orcaPage, 'accounts-codex').getByRole('button', {
        name: 'Add Account'
      })
    ).toBeEnabled()
    await expect(
      accountSection(orcaPage, 'accounts-cursor').getByRole('button', {
        name: 'Refresh usage'
      })
    ).toBeEnabled()
    await expect(
      accountSection(orcaPage, 'accounts-grok').getByRole('button', {
        name: 'Refresh usage'
      })
    ).toBeEnabled()

    // Why: clicking Add Account starts a real provider login, so exercise the
    // MiniMax sign-in helper flow instead; it opens and closes without any login.
    const howToCopy = accountSection(orcaPage, 'accounts-minimax').getByRole('button', {
      name: 'How to copy'
    })
    await expect(howToCopy).toBeEnabled()
    await howToCopy.click()

    const popover = orcaPage.locator('[data-slot="popover-content"]')
    await expect(popover.getByText('How to copy the cookie')).toBeVisible({
      timeout: 10_000
    })
    await expect(popover.getByText(/Open .* in your browser and sign in\./)).toBeVisible()

    await orcaPage.keyboard.press('Escape')
    await expect(popover).toBeHidden()
  })

  test('a fresh profile shows the disconnected empty state instead of account rows', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await openAccountsSettings(orcaPage)

    const claude = accountSection(orcaPage, 'accounts-claude')
    await expect(claude).toBeVisible({ timeout: 15_000 })
    await expect(claude.getByText(/No managed Claude accounts/)).toBeVisible({
      timeout: 15_000
    })
    await expect(claude.getByRole('button', { name: 'System default' })).toBeVisible()
    // No seeded managed account means no confirmation-gated Remove affordance.
    await expect(claude.getByRole('button', { name: 'Remove' })).toHaveCount(0)

    const codex = accountSection(orcaPage, 'accounts-codex')
    await expect(codex).toBeVisible({ timeout: 15_000 })
    await expect(codex.getByText(/No managed Codex accounts/)).toBeVisible({
      timeout: 15_000
    })
    await expect(codex.getByRole('button', { name: 'System default' })).toBeVisible()
    await expect(codex.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  })

  test('read-only provider sections settle into a status state, not a permanent loading state', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await openAccountsSettings(orcaPage)

    const cursor = accountSection(orcaPage, 'accounts-cursor')
    await expect(cursor).toBeVisible({ timeout: 15_000 })
    // Why: a permanent "Loading…" would mean the status read never resolved; a
    // settled section shows either the sign-in identity or the disconnected copy.
    await expect(cursor.getByText('Loading…')).toBeHidden({ timeout: 15_000 })
    await expect(
      cursor.getByText(/No Cursor sign-in found on this computer|Signed in|Sign-in expired/).first()
    ).toBeVisible()

    const grok = accountSection(orcaPage, 'accounts-grok')
    await expect(grok).toBeVisible({ timeout: 15_000 })
    await expect(grok.getByText('Loading…')).toBeHidden({ timeout: 15_000 })
    await expect(
      grok.getByText(/Not signed in to Grok CLI|Signed in|Session expired/).first()
    ).toBeVisible()
  })
})
