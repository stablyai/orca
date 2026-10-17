/**
 * Settings pane navigation E2E.
 *
 * Covers the sidebar → content wiring the Settings page depends on: selecting a
 * nav item renders exactly the matching pane, a deep link opens its target pane,
 * closing Settings returns to the view it replaced, and the sidebar search
 * filters then restores the nav list.
 *
 * Listening only to the DOM (roles + data-settings-section); the store is used
 * only to open Settings and read the previous view.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { SettingsNavTarget } from '../../src/renderer/src/lib/settings-navigation-types'

// Only the active pane's <SettingsSection> carries both the class and the attr.
const ACTIVE_PANE_SELECTOR = 'section.scroll-mt-8[data-settings-section]'

/** Open Settings on the default pane (mirrors a user choosing Settings). */
async function openSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host machine may run a
    // non-English locale, which 'system' would follow.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({
    timeout: 10_000
  })
}

/** Open Settings directly on `pane` (the real deep-link entry point). */
async function openSettingsForPane(page: Page, pane: SettingsNavTarget): Promise<void> {
  await page.evaluate(async (targetPane) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: targetPane, repoId: null })
    store.getState().openSettingsPage()
  }, pane)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({
    timeout: 10_000
  })
}

/** The Settings nav aside, identified by the search field that lives in it. */
function settingsSidebar(page: Page) {
  return page.locator('aside').filter({ has: page.getByPlaceholder('Search settings') })
}

function paneSection(page: Page, id: string) {
  return page.locator(`section.scroll-mt-8[data-settings-section="${id}"]`)
}

test.describe('Settings pane navigation', () => {
  test('selecting a sidebar item renders only that pane', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openSettings(orcaPage)

    const sidebar = settingsSidebar(orcaPage)
    const navItems = [
      { id: 'general', name: 'General' },
      { id: 'appearance', name: 'Appearance' },
      { id: 'terminal', name: 'Terminal' },
      { id: 'integrations', name: 'Integrations' },
      { id: 'privacy', name: 'Privacy & Telemetry' },
      { id: 'agents', name: 'Agents' }
    ] as const

    for (const { id, name } of navItems) {
      const navButton = sidebar.getByRole('button', { name, exact: true })
      await navButton.click()

      await expect(paneSection(orcaPage, id)).toBeVisible({ timeout: 10_000 })
      // Why: inactive sections unmount, so a regression that mounts every pane
      // (or leaves the previous one behind) shows up as a count > 1.
      await expect(orcaPage.locator(ACTIVE_PANE_SELECTOR)).toHaveCount(1)
      await expect(navButton).toHaveAttribute('aria-current', 'page')
    }
  })

  test('deep links open the terminal and integrations panes', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)

    await openSettingsForPane(orcaPage, 'terminal')
    await expect(paneSection(orcaPage, 'terminal')).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.locator(ACTIVE_PANE_SELECTOR)).toHaveCount(1)

    // Leave and re-enter with a different target so the second link is exercised.
    await orcaPage.getByRole('button', { name: 'Back to app' }).click()
    await expect(orcaPage.getByPlaceholder('Search settings')).toHaveCount(0)

    await openSettingsForPane(orcaPage, 'integrations')
    await expect(paneSection(orcaPage, 'integrations')).toBeVisible({
      timeout: 10_000
    })
    // Why: the Integrations pane hosts one card per provider, each its own
    // data-settings-section; a broken deep link renders the shell without them.
    await expect(orcaPage.locator('[data-settings-section="integrations-linear"]')).toBeVisible()
    await expect(orcaPage.locator('[data-settings-section="integrations-jira"]')).toBeVisible()
    await expect(orcaPage.locator(ACTIVE_PANE_SELECTOR)).toHaveCount(1)
  })

  test('closing settings returns to the previous view', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const previousView = await getStoreState<string>(orcaPage, 'activeView')

    await openSettings(orcaPage)
    // The close affordance is the load-bearing, user-visible Settings marker.
    await expect(orcaPage.getByRole('button', { name: 'Back to app' })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Back to app' }).click()

    await expect
      .poll(() => getStoreState<string>(orcaPage, 'activeView'), {
        timeout: 5_000
      })
      .toBe(previousView)
    await expect(orcaPage.getByRole('button', { name: 'Back to app' })).toHaveCount(0)
    // Why: the store check alone would pass even if the previous surface had
    // silently stopped mounting; `.xterm` proves the terminal view actually painted.
    if (previousView === 'terminal') {
      await expect(orcaPage.locator('.xterm').first()).toBeVisible({
        timeout: 5_000
      })
    }
  })

  test('search filters the sidebar and clearing restores it', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openSettings(orcaPage)

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    // Why: a plain Settings open should land focus in search so typing starts immediately.
    await expect(searchInput).toBeFocused()

    const sidebar = settingsSidebar(orcaPage)
    const terminalNav = sidebar.getByRole('button', { name: 'Terminal', exact: true })
    const privacyNav = sidebar.getByRole('button', { name: 'Privacy & Telemetry', exact: true })

    await searchInput.fill('Privacy & Telemetry')
    await expect(privacyNav).toBeVisible()
    // A query that doesn't match Terminal must drop it from the nav list.
    await expect.poll(() => terminalNav.count()).toBe(0)
    const filteredCount = await sidebar.getByRole('button').count()

    await searchInput.fill('')
    await expect(terminalNav).toBeVisible()
    await expect(privacyNav).toBeVisible()
    // Why: clearing must restore the wider list, not just re-show one row.
    await expect.poll(() => sidebar.getByRole('button').count()).toBeGreaterThan(filteredCount)
  })
})
