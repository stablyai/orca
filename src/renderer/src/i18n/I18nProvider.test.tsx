// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultSettings } from '../../../shared/constants'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../shared/ui-language'
import {
  getBrowserLanguageDetection,
  setRendererLanguageDetection
} from '../../../shared/ui-locale'
import { useAppStore } from '@/store'
import { i18n } from './i18n'
import * as rendererI18n from './i18n'
import { useLanguageReadiness } from './language-readiness'
import * as languageReadiness from './language-readiness'
import { usePluginLanguagePackStore } from '../store/plugin-language-packs'
import { I18nProvider } from './I18nProvider'

// Wait for async settings before selecting the OS locale, or an in-flight load can override the persisted preference.

const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

// Stub navigator.language to reproduce a non-English OS independently of the test host.
const ORIGINAL_SYSTEM_LOCALE = navigator.language
function stubSystemLocale(tag: string): void {
  Object.defineProperty(navigator, 'language', { value: tag, configurable: true })
  Object.defineProperty(navigator, 'languages', { value: [tag], configurable: true })
}

async function renderProvider(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(I18nProvider, null, null))
  })
}

beforeEach(() => {
  useLanguageReadiness.setState(useLanguageReadiness.getInitialState(), true)
  vi.spyOn(languageReadiness, 'initializeLanguageDetection').mockImplementation(async () => {
    const detection = getBrowserLanguageDetection()
    setRendererLanguageDetection(detection)
    useLanguageReadiness.setState({ detection })
    return detection
  })
  useAppStore.setState(initialAppState, true)
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  useAppStore.setState(initialAppState, true)
  stubSystemLocale(ORIGINAL_SYSTEM_LOCALE)
  vi.restoreAllMocks()
})

describe('I18nProvider startup language', () => {
  it.each(['loaded', 'failed'] as const)(
    'starts an explicit catalog before detection finishes and waits for detection when %s',
    async (outcome) => {
      const detection = getBrowserLanguageDetection()
      let finishDetection: () => void = () => {}
      vi.spyOn(languageReadiness, 'initializeLanguageDetection').mockImplementation(
        () =>
          new Promise((resolve) => {
            finishDetection = () => resolve(detection)
          })
      )
      const load = vi.spyOn(rendererI18n, 'loadRendererUiLanguage')
      if (outcome === 'loaded') {
        load.mockResolvedValue('fr')
      } else {
        load.mockRejectedValue(new Error('Catalog offline'))
      }
      const changeLanguage = vi.spyOn(i18n, 'changeLanguage')
      useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'fr' } })

      await renderProvider()

      expect(load).toHaveBeenCalledWith('fr')
      expect(changeLanguage).not.toHaveBeenCalled()
      expect(useLanguageReadiness.getState()).toMatchObject({ ready: false, loading: true })

      await act(async () => finishDetection())

      expect(changeLanguage).toHaveBeenCalledWith(outcome === 'loaded' ? 'fr' : 'en')
      await vi.waitFor(() =>
        expect(useLanguageReadiness.getState()).toMatchObject({
          ready: true,
          loading: false,
          error: outcome === 'failed'
        })
      )
    }
  )

  it('waits for detection before resolving the system language catalog', async () => {
    const detection = getBrowserLanguageDetection()
    let finishDetection: () => void = () => {}
    vi.spyOn(languageReadiness, 'initializeLanguageDetection').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDetection = () => resolve(detection)
        })
    )
    const load = vi.spyOn(rendererI18n, 'loadRendererUiLanguage').mockResolvedValue('en')
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'system' } })

    await renderProvider()

    expect(load).not.toHaveBeenCalled()

    await act(async () => finishDetection())

    expect(load).toHaveBeenCalledWith('system')
    expect(useLanguageReadiness.getState().ready).toBe(true)
  })

  it('does not apply any language while settings are still loading', async () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')

    await renderProvider()

    expect(changeLanguage).not.toHaveBeenCalled()
  })

  it('applies the persisted language once settings load', async () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')

    await renderProvider()
    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_SPANISH }
      })
    })

    await vi.waitFor(() => expect(changeLanguage).toHaveBeenCalledWith('es'))
  })

  it('applies persisted English even if i18n reports it as already active', async () => {
    // i18n.language stays stale during lazy loading; comparing it can skip correcting an in-flight OS-locale switch.
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')

    await renderProvider()
    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_ENGLISH }
      })
    })

    expect(changeLanguage).toHaveBeenCalledWith('en')
  })

  it('never applies the OS locale on a non-English system when English is persisted (#7188)', async () => {
    // No locale request may start before persisted settings arrive, even on a Spanish OS.
    stubSystemLocale('es-ES')
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')

    await renderProvider()
    expect(changeLanguage).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_ENGLISH }
      })
    })

    expect(useLanguageReadiness.getState().detection?.locale).toBe('es')
    expect(changeLanguage).toHaveBeenCalledWith('en')
    expect(changeLanguage).not.toHaveBeenCalledWith('es')
  })

  it('switches language when the setting changes after startup', async () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')

    await renderProvider()
    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_ENGLISH }
      })
    })
    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_SPANISH }
      })
    })

    await vi.waitFor(() => expect(changeLanguage).toHaveBeenLastCalledWith('es'))
  })
})

it('does not apply a delayed catalog after a newer saved preference', async () => {
  let finishSpanish: (locale: string) => void = () => {}
  const load = vi
    .spyOn(rendererI18n, 'loadRendererUiLanguage')
    .mockImplementation(async (language) => {
      if (language === 'es') {
        return new Promise<string>((resolve) => {
          finishSpanish = resolve
        })
      }
      return 'en'
    })
  const changeLanguage = vi.spyOn(i18n, 'changeLanguage')
  await renderProvider()
  await act(async () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'es' } })
  })
  await vi.waitFor(() => expect(load).toHaveBeenCalledWith('es'))
  await act(async () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' } })
  })
  await vi.waitFor(() => expect(changeLanguage).toHaveBeenCalledWith('en'))
  await act(async () => finishSpanish('es'))
  expect(changeLanguage).not.toHaveBeenCalledWith('es')
  expect(i18n.language).toBe('en')
})

it('settles catalog failure to English with recovery while preserving the saved language', async () => {
  vi.spyOn(rendererI18n, 'loadRendererUiLanguage').mockRejectedValue(new Error('Catalog offline'))
  await renderProvider()
  await act(async () => {
    useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'fr' } })
  })
  await vi.waitFor(() =>
    expect(useLanguageReadiness.getState()).toMatchObject({ ready: true, error: true })
  )
  expect(i18n.language).toBe('en')
  expect(useAppStore.getState().settings?.uiLanguage).toBe('fr')
})

it('continues in English while plugin discovery is pending without changing the saved preference', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { listLanguagePacks: () => new Promise(() => {}) } }
  })
  usePluginLanguagePackStore.setState({ entries: [], loaded: false })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'plugin:example.missing/de' }
  })
  await renderProvider()
  await vi.waitFor(() =>
    expect(useLanguageReadiness.getState()).toMatchObject({ ready: true, error: false })
  )
  expect(i18n.language).toBe('en')
  expect(usePluginLanguagePackStore.getState().loaded).toBe(false)
  expect(useAppStore.getState().settings?.uiLanguage).toBe('plugin:example.missing/de')
})
