// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/orca-profiles/constants'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugins/localization/plugin-language-packs'
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

it('recovers a late startup catalog while preserving any newer saved preference', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'api', { configurable: true, value: {} })
  let finishCatalog: (response: Response) => void = () => {}
  const catalog = new Promise<Response>((resolve) => {
    finishCatalog = resolve
  })
  vi.stubGlobal('fetch', () => catalog)
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

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })

  expect(screen.getByText('Onboarding available')).toBeTruthy()
  expect(useLanguageReadiness.getState()).toMatchObject({ ready: true, error: true })
  expect(useAppStore.getState().settings?.uiLanguage).toBe('fr')
  expect(i18n.language).toBe('en')
  await act(async () => {
    finishCatalog(new Response('{}'))
    await catalog
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(i18n.language).toBe('fr')
  expect(useLanguageReadiness.getState().error).toBe(false)
  expect(useAppStore.getState().settings?.uiLanguage).toBe('fr')

  let finishNextCatalog: (response: Response) => void = () => {}
  const nextCatalog = new Promise<Response>((resolve) => {
    finishNextCatalog = resolve
  })
  vi.stubGlobal('fetch', () => nextCatalog)
  usePluginLanguagePackStore.setState({ entries: [], loaded: true })
  await act(async () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'ja' } })
  })

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(i18n.language).toBe('en')

  await act(async () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' } })
  })
  await act(async () => {
    finishNextCatalog(new Response('{}'))
    await nextCatalog
    await vi.advanceTimersByTimeAsync(0)
  })

  expect(i18n.language).toBe('en')
  expect(useAppStore.getState().settings?.uiLanguage).toBe('en')
  expect(useLanguageReadiness.getState().error).toBe(false)
})
