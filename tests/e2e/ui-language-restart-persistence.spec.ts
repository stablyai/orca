/**
 * E2E repro: the persisted UI language must survive an app restart.
 *
 * User report: on a Chinese-locale system, switching the UI language to
 * English works immediately, but after quitting and relaunching the app the
 * UI renders in Chinese again — even though the settings pane still shows
 * "English" as the selected language.
 *
 * The suspected mechanism is a boot race in I18nProvider: on first render the
 * settings slice is still null, so the language falls back to "system"
 * (Chinese) and kicks off an async changeLanguage('zh') that lazily imports
 * the zh catalog. When the persisted settings ('en') arrive moments later,
 * the provider's `i18n.language !== locale` guard sees the still-active 'en'
 * (the zh switch has not completed yet) and skips the corrective change; the
 * in-flight zh switch then lands and the UI ends up Chinese.
 *
 * Both launches pass `--lang=zh-CN` so navigator.language / app.getLocale()
 * report a Chinese system locale regardless of the host machine.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import './helpers/runtime-types'

// Why: this spec does a full quit→relaunch cycle (two Electron instances
// back-to-back); serial keeps cold-start contention out of the failure mode.
test.describe.configure({ mode: 'serial' })

const SEARCH_SETTINGS_PLACEHOLDER_EN = 'Search settings'
const SEARCH_SETTINGS_PLACEHOLDER_ZH = '搜索设置'

async function openSettingsPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
}

/**
 * The settings search input placeholder is the language probe: it renders on
 * every settings open, has distinct en/zh translations, and needs no pointer
 * interaction (first-run announcement overlays can cover the pane).
 */
function settingsSearchInput(page: Page, placeholder: string) {
  return page.getByPlaceholder(placeholder)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
test('UI language set to English survives an app restart on a Chinese-locale system', async ({}, testInfo) => {
  const session = createRestartSession(testInfo, { extraElectronArgs: ['--lang=zh-CN'] })

  try {
    // ── Launch 1: default settings (uiLanguage: system) on a zh system ──
    const first = await session.launch()

    await openSettingsPage(first.page)
    // System locale zh applies after the lazy zh catalog loads.
    await expect(settingsSearchInput(first.page, SEARCH_SETTINGS_PLACEHOLDER_ZH)).toBeVisible({
      timeout: 15_000
    })

    // Same code path as the Language select in Settings → Appearance.
    await first.page.evaluate(async () => {
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })

    // The switch to English takes effect live, as the user reported.
    await expect(settingsSearchInput(first.page, SEARCH_SETTINGS_PLACEHOLDER_EN)).toBeVisible({
      timeout: 15_000
    })

    await session.close(first.app)

    // ── Launch 2: same userDataDir — persisted uiLanguage must win ──
    const second = await session.launch()

    // The persisted setting really is English (matches what the settings
    // pane displays after restart in the user report).
    const persistedUiLanguage = await second.page.evaluate(async () => {
      const settings = await window.api.settings.get()
      return settings.uiLanguage
    })
    expect(persistedUiLanguage).toBe('en')

    // Wait until the renderer store has hydrated the persisted settings, so
    // the I18nProvider has seen uiLanguage 'en'.
    await second.page.waitForFunction(
      () => window.__store?.getState().settings?.uiLanguage === 'en',
      null,
      { timeout: 30_000 }
    )

    // Why: the bug is a race where an in-flight system-locale (zh) catalog
    // load lands *after* the persisted 'en' was observed. Give any pending
    // lazy locale load ample time to settle before asserting, otherwise the
    // still-English transient boot state would make this a false pass.
    await second.page.waitForTimeout(3_000)

    await openSettingsPage(second.page)
    const searchInputAnyLanguage = second.page
      .locator(
        `input[placeholder="${SEARCH_SETTINGS_PLACEHOLDER_EN}"], ` +
          `input[placeholder="${SEARCH_SETTINGS_PLACEHOLDER_ZH}"]`
      )
      .first()
    await expect(searchInputAnyLanguage).toBeVisible({ timeout: 15_000 })
    const placeholderAfterRestart = await searchInputAnyLanguage.getAttribute('placeholder')

    // Expected behavior: the UI is still English after the restart.
    expect(placeholderAfterRestart).toBe(SEARCH_SETTINGS_PLACEHOLDER_EN)

    await session.close(second.app)
  } finally {
    await session.dispose()
  }
})
