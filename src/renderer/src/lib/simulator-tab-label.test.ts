import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { SIMULATOR_DEFAULT_TAB_LABEL, formatSimulatorTabLabel } from './simulator-tab-label'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

it('translates the stored default label but keeps device names', async () => {
  await i18n.changeLanguage('es')
  expect(formatSimulatorTabLabel(SIMULATOR_DEFAULT_TAB_LABEL)).toBe('Emulador móvil')
  expect(formatSimulatorTabLabel('')).toBe('Emulador móvil')
  expect(formatSimulatorTabLabel('iPhone 16 Pro')).toBe('iPhone 16 Pro')
})
