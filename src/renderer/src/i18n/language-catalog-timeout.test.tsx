// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { OnboardingLanguageLoading } from '@/components/onboarding/OnboardingLanguageLoading'
import { I18nProvider } from './I18nProvider'
import { i18n } from './i18n'
import { useLanguageReadiness } from './language-readiness'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('releases onboarding in English when a catalog stalls, ignores its late result, and can retry', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'api', { configurable: true, value: {} })
  let finishCatalog: (response: Response) => void = () => {}
  const catalog = new Promise<Response>((resolve) => {
    finishCatalog = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(catalog)
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ menu: { file: 'Fichier' } })))
      )
  )
  usePluginLanguagePackStore.setState({ entries: [], loaded: true })
  useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'fr' } })
  useLanguageReadiness.setState({ ready: false, error: false })
  function OnboardingGate(): React.JSX.Element {
    const ready = useLanguageReadiness((state) => state.ready)
    return ready ? <p>Onboarding available</p> : <OnboardingLanguageLoading />
  }
  render(
    <I18nProvider>
      <OnboardingGate />
    </I18nProvider>
  )
  expect(screen.getByRole('status').textContent).toContain('Loading language')

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })

  expect(screen.getByText('Onboarding available')).toBeTruthy()
  expect(useLanguageReadiness.getState()).toMatchObject({ ready: true, error: true })
  expect(useAppStore.getState().settings?.uiLanguage).toBe('fr')
  expect(i18n.language).toBe('en')
  await act(async () => {
    finishCatalog(new Response(JSON.stringify({ menu: { file: 'Fichier' } })))
    await catalog
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(i18n.language).toBe('en')
  expect(useLanguageReadiness.getState().error).toBe(true)

  await act(async () => {
    useLanguageReadiness.getState().retryLanguageLoad()
  })
  await act(async () => {
    await vi.waitFor(() => expect(i18n.language).toBe('fr'))
  })

  expect(i18n.language).toBe('fr')
  expect(useLanguageReadiness.getState().error).toBe(false)
  expect(i18n.t('menu.file')).toBe('Fichier')
})
