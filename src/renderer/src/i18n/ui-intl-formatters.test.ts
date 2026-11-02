import { afterEach, expect, it } from 'vitest'
import { i18n, loadRendererUiLanguage } from './i18n'
import { uiNumberFormat } from './ui-intl-formatters'

const GROUPED: Intl.NumberFormatOptions = {}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('rebuilds a shared formatter when the UI language changes', async () => {
  expect(uiNumberFormat(GROUPED).format(1234.5)).toBe('1,234.5')
  await i18n.changeLanguage(await loadRendererUiLanguage('de'))
  expect(uiNumberFormat(GROUPED).format(1234.5)).toBe('1.234,5')
})
