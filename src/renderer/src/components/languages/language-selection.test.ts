// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { loadRendererUiLanguage } from '@/i18n/i18n'
import { selectUiLanguage } from './language-selection'

vi.mock('@/i18n/i18n', () => ({ loadRendererUiLanguage: vi.fn(), translate: vi.fn() }))

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.clearAllMocks()
})

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('preserves the latest choice when an earlier save completes during its catalog download', async () => {
  const savingJapanese = deferred()
  const finishJapanese = deferred()
  const frenchCatalog = deferred()
  vi.mocked(loadRendererUiLanguage).mockImplementation(async (language) => {
    if (language === 'fr') {
      await frenchCatalog.promise
    }
    return language === 'fr' ? 'fr' : 'ja'
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' },
    updateSettingsOrThrow: async (updates) => {
      if (updates.uiLanguage === 'ja') {
        savingJapanese.resolve()
        await finishJapanese.promise
      }
      useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
    }
  })
  const japanese = selectUiLanguage('ja')
  await savingJapanese.promise
  const french = selectUiLanguage('fr')
  finishJapanese.resolve()
  await japanese
  frenchCatalog.resolve()
  await french
  expect(useAppStore.getState().settings?.uiLanguage).toBe('fr')
})

it('keeps the saved language when the picker closes before its catalog arrives', async () => {
  const catalog = deferred()
  let pickerOpen = true
  vi.mocked(loadRendererUiLanguage).mockImplementation(async () => {
    await catalog.promise
    return 'fr'
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' },
    updateSettingsOrThrow: async (updates) => {
      useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
    }
  })
  const changing = selectUiLanguage('fr', () => pickerOpen)
  pickerOpen = false
  catalog.resolve()
  await changing
  expect(useAppStore.getState().settings?.uiLanguage).toBe('en')
})
