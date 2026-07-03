/**
 * E2E repro: switching the UI language while Settings is open must retranslate
 * the Settings sidebar navigation items immediately.
 *
 * User report: after changing the language (e.g. English → Chinese), the main
 * settings pane switches live, but the left sidebar nav items ("General",
 * "Appearance", …) stay in the previous language until Settings is closed and
 * reopened. No app restart involved.
 *
 * Suspected mechanism: useSettingsNavigationMetadata() subscribes to language
 * changes via useTranslation(), but memoizes the translated section list with
 * deps that do not change on a language switch — so the rerender returns the
 * stale previous-language array. Remounting Settings recomputes the memo,
 * which is why reopening "fixes" it.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import './helpers/runtime-types'

const GENERAL_NAV_EN = 'General'
const GENERAL_NAV_ZH = '通用'
const SEARCH_SETTINGS_PLACEHOLDER_EN = 'Search settings'
const SEARCH_SETTINGS_PLACEHOLDER_ZH = '搜索设置'

async function openSettingsPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
}

async function closeSettingsPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().closeSettingsPage()
  })
}

/** The "General" sidebar nav row, matched exactly in the given language. */
function generalNavItem(page: Page, label: string) {
  return page.getByRole('button', { name: label, exact: true }).first()
}

test('settings sidebar nav retranslates immediately when the UI language changes', async ({
  orcaPage
}) => {
  // Establish a known-English baseline regardless of the host system locale:
  // pick English, wait for the render-time-translated search placeholder to
  // flip, then remount Settings so the nav metadata is computed in English.
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
  })
  await openSettingsPage(orcaPage)
  await expect(orcaPage.getByPlaceholder(SEARCH_SETTINGS_PLACEHOLDER_EN)).toBeVisible({
    timeout: 15_000
  })
  await closeSettingsPage(orcaPage)
  await openSettingsPage(orcaPage)
  await expect(generalNavItem(orcaPage, GENERAL_NAV_EN)).toBeVisible({ timeout: 15_000 })

  // Same code path as the Language select in Settings → Appearance.
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'zh' })
  })

  // The zh catalog is active once render-time translations show Chinese: the
  // sidebar's own search placeholder retranslates on the language-change
  // rerender, so it flipping proves everything except the memoized nav list
  // has switched.
  await expect(orcaPage.getByPlaceholder(SEARCH_SETTINGS_PLACEHOLDER_ZH)).toBeVisible({
    timeout: 15_000
  })

  // Expected behavior: the nav item is Chinese without reopening Settings.
  await expect(generalNavItem(orcaPage, GENERAL_NAV_ZH)).toBeVisible({ timeout: 5_000 })

  // Reopening Settings must also show the Chinese nav (the user's workaround).
  await closeSettingsPage(orcaPage)
  await openSettingsPage(orcaPage)
  await expect(generalNavItem(orcaPage, GENERAL_NAV_ZH)).toBeVisible({ timeout: 15_000 })
})
