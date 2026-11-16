// @vitest-environment happy-dom

import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const SUGGESTION_ID = 'language-pack-discovery'

type HostTestState = {
  app: {
    settings: Record<string, unknown>
    persistedUIReady: boolean
    activeModal: string
    activeView: string
    updateSettings: (patch: Record<string, unknown>) => Promise<void>
  }
  toasts: { id: string }[]
}

const state = vi.hoisted((): HostTestState => ({
  app: {
    settings: { uiLanguage: 'system', pluginSystemEnabled: true },
    persistedUIReady: true,
    activeModal: 'none',
    activeView: 'terminal',
    updateSettings: async (patch) => {
      state.app.settings = { ...state.app.settings, ...patch }
    }
  },
  toasts: []
}))
const toastApi = vi.hoisted(() => ({ custom: vi.fn(), dismiss: vi.fn(), getToasts: () => [] }))
const packs = vi.hoisted(() => [
  { id: 'plugin:ebbop.orca-it/it', locale: 'it', listing: { pluginKey: 'ebbop.orca-it' } }
])

vi.mock('sonner', () => ({ toast: toastApi, useSonner: () => ({ toasts: state.toasts }) }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (s: HostTestState['app']) => unknown) => select(state.app), {
    getState: () => state.app
  })
}))
vi.mock('@/i18n/language-readiness', () => ({
  useLanguageReadiness: (select: (s: unknown) => unknown) =>
    select({ detection: { status: 'unsupported', detectedTag: 'it-IT' } })
}))
vi.mock('@/i18n/ui-intl-formatters', () => ({ languageDisplayName: (locale: string) => locale }))
vi.mock('@/store/plugins/localization/plugin-language-packs', () => ({
  usePluginLanguagePacks: () => []
}))
vi.mock('./use-language-pack-catalog', () => ({ useLanguagePackCatalog: () => ({ packs }) }))
vi.mock('./use-language-offer-action', () => ({
  useLanguageOfferAction: () => ({ accept: vi.fn(), progress: null, errorFor: () => null })
}))
vi.mock('./use-language-suggestion-surface', () => ({
  useLanguageSuggestionSurfaceBlocked: () => false,
  isLanguageSuggestionSurfaceBlocked: () => false
}))

import { LanguagePackDiscoveryHost } from './LanguagePackDiscoveryHost'

it('keeps the visible suggestion when another toast appears or Settings opens', async () => {
  vi.useFakeTimers()
  const view = render(<LanguagePackDiscoveryHost onboardingKnown onboardingVisible={false} />)
  await act(async () => {
    vi.advanceTimersByTime(15000)
  })
  expect(toastApi.custom).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ id: SUGGESTION_ID })
  )

  state.toasts = [{ id: SUGGESTION_ID }, { id: 'tab-id-copied' }]
  state.app.activeView = 'settings'
  await act(async () => {
    view.rerender(<LanguagePackDiscoveryHost onboardingKnown onboardingVisible={false} />)
    vi.advanceTimersByTime(30000)
  })
  expect(toastApi.dismiss).not.toHaveBeenCalledWith(SUGGESTION_ID)
  vi.useRealTimers()
})
