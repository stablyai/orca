/**
 * Settings → terminal appearance E2E coverage.
 *
 * The controls this spec drives live in two real destinations, so it opens both:
 *   - Terminal font size + font family + cursor shape/blink sit under
 *     Settings → Appearance → "Terminal" (`TerminalAppearanceSection`, rendered
 *     by `AppearancePane`). Cursor controls are inside the Advanced disclosure.
 *   - Scrollback presets sit under Settings → Terminal → Advanced
 *     (`TerminalAdvancedSection`).
 *
 * Every final assertion targets the DOM (input value, radiogroup/switch
 * aria-checked, combobox value); `window.__store` reads only corroborate that the
 * change persisted. A live xterm pane exposes no stable font-size DOM attribute,
 * but the Appearance pane's terminal preview renders xterm's `.xterm-rows`
 * container, whose computed font-size is the active terminal font size — that is
 * used to prove a real terminal surface adopts a font-size change.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeSettingsPage, dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { getStoreState, waitForSessionReady } from './helpers/store'

type SettingsPane = 'appearance' | 'terminal'

// Id rendered by AppearanceSection for the nested Terminal accordion (`appearance-section-${id}`).
const TERMINAL_ACCORDION = '#appearance-section-terminal'
// Font Size is the only number input bounded 10..24 inside the terminal section.
const FONT_SIZE_INPUT = 'input[type="number"][min="10"][max="24"]'

async function openSettingsPane(page: Page, pane: SettingsPane): Promise<void> {
  await page.evaluate(async (targetPane) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host machine may run another locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: targetPane, repoId: null })
    store.getState().openSettingsPage()
  }, pane)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
}

/** Unmount Settings, then reopen it so controls re-read persisted settings. */
async function reopenSettingsPane(page: Page, pane: SettingsPane): Promise<void> {
  await closeSettingsPage(page)
  await openSettingsPane(page, pane)
}

test.describe('Settings terminal appearance', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('renders terminal typography, cursor, and scrollback controls', async ({ orcaPage }) => {
    await openSettingsPane(orcaPage, 'appearance')

    const appearanceSection = orcaPage.locator('[data-settings-section="appearance"]')
    await expect(
      appearanceSection.getByRole('heading', { name: 'Appearance', exact: true })
    ).toBeVisible()

    const terminalRegion = orcaPage.locator(TERMINAL_ACCORDION)
    await expect(terminalRegion).toBeVisible()
    await expect(terminalRegion.getByText('Terminal Typography', { exact: true })).toBeVisible()
    await expect(terminalRegion.locator(FONT_SIZE_INPUT)).toBeVisible()
    await expect(terminalRegion.getByRole('combobox')).toBeVisible()

    // Why: cursor controls sit behind the Advanced disclosure; a search force-opens it.
    await orcaPage.getByPlaceholder('Search settings').fill('cursor')
    await expect(orcaPage.getByRole('radiogroup', { name: 'Cursor Shape' })).toBeVisible()
    await expect(orcaPage.getByRole('switch', { name: 'Blinking Cursor' })).toBeVisible()

    // Scrollback lives on the Terminal pane, not the Appearance pane.
    await openSettingsPane(orcaPage, 'terminal')
    const terminalSection = orcaPage.locator('[data-settings-section="terminal"]')
    await expect(
      terminalSection.getByRole('heading', { name: 'Terminal', exact: true })
    ).toBeVisible()
    await expect(terminalSection.getByText('Scrollback Rows', { exact: true })).toBeVisible()
    await expect(terminalSection.getByText('10k', { exact: true })).toBeVisible()
  })

  test('changing the terminal font size updates the control and persists', async ({ orcaPage }) => {
    await openSettingsPane(orcaPage, 'appearance')

    const fontInput = orcaPage.locator(`${TERMINAL_ACCORDION} ${FONT_SIZE_INPUT}`)
    await expect(fontInput).toBeVisible()

    const initial = await getStoreState<number>(orcaPage, 'settings.terminalFontSize')
    const next = initial === 18 ? 19 : 18
    await fontInput.fill(String(next))

    await expect(fontInput).toHaveValue(String(next))
    await expect
      .poll(() => getStoreState<number>(orcaPage, 'settings.terminalFontSize'), {
        timeout: 5_000,
        message: 'terminal font size did not persist to settings'
      })
      .toBe(next)

    // Survives a Settings remount.
    await reopenSettingsPane(orcaPage, 'appearance')
    await expect(orcaPage.locator(`${TERMINAL_ACCORDION} ${FONT_SIZE_INPUT}`)).toHaveValue(
      String(next)
    )
  })

  test('changing cursor style and blink persists and is reflected on re-render', async ({
    orcaPage
  }) => {
    await openSettingsPane(orcaPage, 'appearance')
    await orcaPage.getByPlaceholder('Search settings').fill('cursor')

    const cursorShape = orcaPage.getByRole('radiogroup', { name: 'Cursor Shape' })
    await expect(cursorShape).toBeVisible()
    const underline = cursorShape.getByRole('radio', { name: 'Underline' })
    await underline.click()
    await expect(underline).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => getStoreState<string>(orcaPage, 'settings.terminalCursorStyle'), {
        timeout: 5_000,
        message: 'cursor style did not persist'
      })
      .toBe('underline')

    const blink = orcaPage.getByRole('switch', { name: 'Blinking Cursor' })
    const blinkBefore = await getStoreState<boolean>(orcaPage, 'settings.terminalCursorBlink')
    const blinkAfter = !blinkBefore
    await blink.click()
    await expect(blink).toHaveAttribute('aria-checked', String(blinkAfter))
    await expect
      .poll(() => getStoreState<boolean>(orcaPage, 'settings.terminalCursorBlink'), {
        timeout: 5_000,
        message: 'cursor blink did not persist'
      })
      .toBe(blinkAfter)

    // Remount: the controls reflect stored choices, not transient component state.
    await reopenSettingsPane(orcaPage, 'appearance')
    await orcaPage.getByPlaceholder('Search settings').fill('cursor')
    await expect(
      orcaPage
        .getByRole('radiogroup', { name: 'Cursor Shape' })
        .getByRole('radio', { name: 'Underline' })
    ).toHaveAttribute('aria-checked', 'true')
    await expect(orcaPage.getByRole('switch', { name: 'Blinking Cursor' })).toHaveAttribute(
      'aria-checked',
      String(blinkAfter)
    )
  })

  test('selecting a terminal font family from the autocomplete persists the value', async ({
    orcaPage
  }) => {
    await openSettingsPane(orcaPage, 'appearance')

    const fontCombo = orcaPage.locator(TERMINAL_ACCORDION).getByRole('combobox')
    await expect(fontCombo).toBeVisible()

    const current = await getStoreState<string>(orcaPage, 'settings.terminalFontFamily')
    // Both ship in `getFallbackTerminalFonts()` on every platform, so the option always exists.
    const target = current === 'Fira Code' ? 'JetBrains Mono' : 'Fira Code'

    await fontCombo.click()
    const option = orcaPage.getByRole('option', { name: target, exact: true })
    await expect(option).toBeVisible({ timeout: 10_000 })
    await option.click()

    await expect(fontCombo).toHaveValue(target)
    await expect
      .poll(() => getStoreState<string>(orcaPage, 'settings.terminalFontFamily'), {
        timeout: 5_000,
        message: 'terminal font family did not persist'
      })
      .toBe(target)
  })

  test('the terminal appearance preview adopts the updated font size', async ({ orcaPage }) => {
    await openSettingsPane(orcaPage, 'appearance')

    const terminalRegion = orcaPage.locator(TERMINAL_ACCORDION)
    // Why: xterm's canvas char-size strategy ships no `.xterm-char-measure-element`;
    // its DOM renderer publishes the active font size on the rendered row container.
    const previewRows = terminalRegion.locator('.xterm-rows')
    await expect(previewRows).toHaveCount(1)

    const fontInput = terminalRegion.locator(FONT_SIZE_INPUT)
    const initial = await getStoreState<number>(orcaPage, 'settings.terminalFontSize')
    const next = initial === 20 ? 21 : 20
    await fontInput.fill(String(next))

    // xterm re-injects `.xterm-rows { font-size: <n>px }` when the option changes.
    await expect
      .poll(() => previewRows.evaluate((element) => getComputedStyle(element).fontSize), {
        timeout: 10_000,
        message: 'preview terminal did not adopt the new font size'
      })
      .toBe(`${next}px`)
  })
})
