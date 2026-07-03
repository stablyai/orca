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
