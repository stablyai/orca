// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultSettings } from '../../../shared/constants'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { i18n } from './i18n'
import { I18nProvider } from './I18nProvider'

// Why: settings arrive async over IPC after first render. The provider used to
// fall back to the 'system' language while settings were null, kicking off an
// OS-locale changeLanguage that raced with — and could permanently override —
// the persisted preference. These tests pin the fixed ordering.

const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

// Why: the 'system' UI language resolves through navigator.language; stubbing it
// lets these tests simulate a non-English OS locale (the #7188 repro) without
// depending on the host machine's locale.
const ORIGINAL_SYSTEM_LOCALE = navigator.language
function stubSystemLocale(tag: string): void {
  Object.defineProperty(navigator, 'language', { value: tag, configurable: true })
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

    expect(changeLanguage).toHaveBeenCalledWith('es')
  })

  it('applies persisted English even if i18n reports it as already active', async () => {
    // Why: i18n.language stays stale while a lazy catalog load is in flight; a
    // guard comparing against it skipped the correction back to the persisted
    // language and let the in-flight OS locale win.
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
    // Why: on a Spanish OS the pre-fix provider kicked off changeLanguage('es')
    // while settings were still null, and the in-flight OS switch then beat the
    // persisted English preference. The fix applies nothing until settings load.
    stubSystemLocale('es-ES')
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')

    await renderProvider()
    // No OS-locale switch is kicked off while settings are still loading.
    expect(changeLanguage).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_ENGLISH }
      })
    })

    // English wins and the Spanish OS locale is never requested.
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

    expect(changeLanguage).toHaveBeenLastCalledWith('es')
  })
})
