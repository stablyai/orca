// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugins/localization/plugin-language-packs'
import { I18nProvider } from '@/i18n/I18nProvider'
import { i18n } from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { AppearanceLanguageSetting } from './AppearanceLanguageSetting'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it('re-picking the saved language retries a catalog that failed to load', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'api', { configurable: true, value: {} })
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ menu: { file: 'Fichier' } })))
      )
  )
  usePluginLanguagePackStore.setState({ entries: [], loaded: true })
  useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'fr' } })
  const updateSettings = vi.fn()
  render(
    <I18nProvider>
      <AppearanceLanguageSetting uiLanguage="fr" updateSettings={updateSettings} forceVisible />
    </I18nProvider>
  )
  await act(async () => {
    await vi.waitFor(() => expect(useLanguageReadiness.getState().error).toBe(true))
  })
  expect(i18n.language).toBe('en')

  fireEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('option', { name: 'Français' }))
  })
  await act(async () => {
    await vi.waitFor(() => expect(i18n.language).toBe('fr'))
  })

  expect(useLanguageReadiness.getState().error).toBe(false)
  expect(updateSettings).not.toHaveBeenCalled()
})
