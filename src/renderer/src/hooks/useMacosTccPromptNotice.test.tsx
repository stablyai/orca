// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { UI_LANGUAGE_SPANISH } from '../../../shared/ui-language'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { i18n } from '@/i18n/i18n'
import { FULL_DISK_ACCESS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'

import { useMacosTccPromptNotice } from './useMacosTccPromptNotice'

type NoticeCallback = (payload: { promptCount: number }, acknowledge: () => void) => void

const subscribeToMacosTccPromptNotice = vi.hoisted(() =>
  vi.fn<(_: unknown, onNotice: NoticeCallback) => () => void>(() => vi.fn())
)
const toastWarning = vi.hoisted(() => vi.fn())

vi.mock('./macos-tcc-prompt-notice-subscription', () => ({
  dismissMacosTccPromptNotice: vi.fn(),
  subscribeToMacosTccPromptNotice
}))
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))

const initialAppState = useAppStore.getInitialState()
const initialPluginLanguagePackState = usePluginLanguagePackStore.getInitialState()
let root: Root | null = null

function NoticeProbe(): null {
  useMacosTccPromptNotice()
  return null
}

beforeEach(async () => {
  useAppStore.setState(initialAppState, true)
  usePluginLanguagePackStore.setState(initialPluginLanguagePackState, true)
  subscribeToMacosTccPromptNotice.mockClear()
  toastWarning.mockClear()
  await i18n.changeLanguage('en')
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = null
  }
  useAppStore.setState(initialAppState, true)
  usePluginLanguagePackStore.setState(initialPluginLanguagePackState, true)
})

it('waits for the persisted locale catalog before consuming the one-time notice', async () => {
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(I18nextProvider, { i18n }, createElement(NoticeProbe)))
  })
  expect(subscribeToMacosTccPromptNotice).not.toHaveBeenCalled()

  await act(async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), uiLanguage: UI_LANGUAGE_SPANISH }
    })
  })
  expect(subscribeToMacosTccPromptNotice).not.toHaveBeenCalled()

  await act(async () => {
    await i18n.changeLanguage('es')
  })
  expect(subscribeToMacosTccPromptNotice).toHaveBeenCalledOnce()
})

it('acknowledges when opening Settings closes the notice', async () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' }
  })
  const container = document.createElement('div')
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(I18nextProvider, { i18n }, createElement(NoticeProbe)))
  })
  const showNotice = subscribeToMacosTccPromptNotice.mock.calls[0]?.[1] as
    | NoticeCallback
    | undefined
  const acknowledge = vi.fn()

  showNotice?.({ promptCount: 1 }, acknowledge)

  const options = toastWarning.mock.calls[0]?.[1] as
    | { action?: { onClick: () => void } }
    | undefined
  options?.action?.onClick()
  expect(acknowledge).toHaveBeenCalledOnce()
  expect(useAppStore.getState().settingsNavigationTarget).toEqual({
    pane: 'developer-permissions',
    repoId: null,
    sectionId: FULL_DISK_ACCESS_SETTINGS_TARGET_ID
  })
})
