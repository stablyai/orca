import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useAppStore } from '../../../store'
import type { SettingsStoreModel } from '../use-settings-store-model'
import type { SettingsInteractionModel } from '../use-settings-interaction-controller'
import { normalizeSourceControlAiSettings } from '../../../../../shared/source-control-ai'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../../../../shared/agent-launch-settings'

const originalState = useAppStore.getState()
const originalApi = window.api
export const persist = vi.fn<(updates: Partial<GlobalSettings>) => Promise<GlobalSettings>>()

export const runtimeCall: Mock = vi.fn()

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
  runtimeCall
    .mockReset()
    .mockImplementation(
      async (request: { method: string; params: AgentLaunchSettingsMutation }) => {
        expect(request.method).toBe('settings.mutateAgentLaunch')
        const current = await window.api.settings.get()
        const updates = agentLaunchSettingsMutationUpdates(current, request.params, 'darwin')
        const saved = persist(updates)
        useAppStore.setState(({ settings }) => ({
          settings: settings && { ...settings, ...updates }
        }))
        return { ok: true, result: { settings: projectAgentLaunchSettings(await saved) } }
      }
    )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: { set: persist, get: vi.fn(async () => useAppStore.getState().settings) },
      runtime: { call: runtimeCall },
      preflight: { detectAgents: async () => [] }
    }
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
