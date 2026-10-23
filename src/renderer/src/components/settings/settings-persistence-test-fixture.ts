import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '../../store'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionModel } from './use-settings-interaction-controller'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'

const originalState = useAppStore.getState()
const originalApi = window.api
export const persist = vi.fn<(updates: Partial<GlobalSettings>) => Promise<GlobalSettings>>()

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/synthetic'),
      experimentalNativeChat: true,
      sourceControlAi: normalizeSourceControlAiSettings({
        ...normalizeSourceControlAiSettings(undefined),
        enabled: false,
        actions: { commitMessage: { commandInputTemplate: 'Keep the Git recipe' } }
      })
    },
    settingsSearchQuery: 'Chat names'
  })
  persist.mockImplementation(async (updates) => {
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Settings fixture is missing')
    }
    return { ...settings, ...updates }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { set: persist } }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  vi.restoreAllMocks()
})

export type SettingsPersistenceModel = SettingsInteractionModel &
  Pick<
    SettingsStoreModel,
    'showDesktopOnlySettings' | 'sourceControlAiPromptDiscardSignal' | 'updateSettings'
  >

export function settingsModel(): SettingsPersistenceModel {
  const state = useAppStore.getState()
  const model = {
    settings: state.settings,
    updateSettings: state.updateSettings,
    updateSettingsOrThrow: state.updateSettingsOrThrow,
    showDesktopOnlySettings: true,
    sourceControlAiPromptDiscardSignal: 0,
    closeSettingsPage: vi.fn(),
    confirm: vi.fn(async () => false),
    hasUnsavedBranchPromptChanges: false,
    hasUnsavedChatPromptChanges: false,
    hasUnsavedCommitPromptChanges: false,
    highlightedSettingsTargetId: null,
    setFontSuggestions: vi.fn(),
    setHasUnsavedBranchPromptChanges: vi.fn(),
    setHasUnsavedChatPromptChanges: vi.fn(),
    setHasUnsavedCommitPromptChanges: vi.fn(),
    setHighlightedSettingsTargetId: vi.fn(),
    setSettingsSearchQuery: vi.fn(),
    setSourceControlAiPromptDiscardSignal: vi.fn()
  } satisfies SettingsPersistenceModel
  return model
}
