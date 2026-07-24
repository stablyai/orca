import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/types'
import { toast } from 'sonner'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible,
  unwrapRuntimeRpcResult
} from '@/runtime/runtime-rpc-client'
import { assertRuntimeStatusCompatible } from '@/runtime/runtime-protocol-compat'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { normalizeTerminalQuickCommands } from '../../../../shared/terminal-quick-commands'
import { normalizeTerminalCustomThemes } from '../../../../shared/terminal-custom-themes'
import { normalizeTaskProviderSettings } from '../../../../shared/task-providers'
import { normalizeOpenInApplications } from '../../../../shared/open-in-applications'
import { createSettingsSearchState, type SettingsSearchState } from './settings-search-state'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../../shared/tui-agent-launch-defaults'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'
import { normalizeUiLanguage } from '../../../../shared/ui-language'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../shared/terminal-scrollback-policy'
import { translate } from '@/i18n/i18n'

export type SettingsSlice = SettingsSearchState & {
  settings: GlobalSettings | null
  fetchSettings: () => Promise<void>
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  setActiveRuntimeEnvironmentPreference: (environmentId: string | null) => Promise<boolean>
}

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

function normalizeRuntimeEnvironmentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function createOpenInApplicationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `open-in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

async function verifyRuntimeEnvironmentReachable(environmentId: string | null): Promise<void> {
  if (!environmentId) {
    return
  }
  const response = await window.api.runtimeEnvironments.getStatus({
    selector: environmentId,
    timeoutMs: 15_000
  })
  const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
  assertRuntimeStatusCompatible(status)
  // Why: the switch probe already proved compatibility; avoid immediately
  // re-probing through the heavier generic runtime RPC path during hydration.
  markRuntimeEnvironmentCompatible(environmentId)
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set, get) => ({
  settings: null,
  ...createSettingsSearchState((state) => set(state)),

  fetchSettings: async () => {
    try {
      const settings = await window.api.settings.get()
      set({ settings })
      // Why: best-effort boot probe so sidebar host pickers show live runtime
      // health before the settings pane is ever opened. Fire-and-forget to keep
      // startup off the network round-trips.
      void get().hydrateRuntimeEnvironmentStatuses()
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    }
  },

  updateSettings: async (updates) => {
    try {
      const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedUpdates } =
        updates as LegacyTerminalScrollbackSettingsUpdate
      void _legacyScrollbackBytes
      if ('terminalQuickCommands' in updates) {
        sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
          updates.terminalQuickCommands
        )
      }
      if ('terminalCustomThemes' in updates) {
        sanitizedUpdates.terminalCustomThemes = normalizeTerminalCustomThemes(
          updates.terminalCustomThemes
        )
      }
      if ('visibleTaskProviders' in updates || 'defaultTaskSource' in updates) {
        const taskProviderSettings = normalizeTaskProviderSettings({
          visibleTaskProviders:
            'visibleTaskProviders' in updates
              ? updates.visibleTaskProviders
              : get().settings?.visibleTaskProviders,
          defaultTaskSource:
            'defaultTaskSource' in updates
              ? updates.defaultTaskSource
              : get().settings?.defaultTaskSource
        })
        sanitizedUpdates.defaultTaskSource = taskProviderSettings.defaultTaskSource
        sanitizedUpdates.visibleTaskProviders = taskProviderSettings.visibleTaskProviders
      }
      if ('openInApplications' in updates) {
        sanitizedUpdates.openInApplications = normalizeOpenInApplications(
          updates.openInApplications,
          {
            createId: createOpenInApplicationId
          }
        )
      }
      if ('disabledTuiAgents' in updates) {
        sanitizedUpdates.disabledTuiAgents = normalizeDisabledTuiAgents(updates.disabledTuiAgents)
      }
      if ('agentDefaultArgs' in updates) {
        sanitizedUpdates.agentDefaultArgs = normalizeTuiAgentArgsRecord(updates.agentDefaultArgs)
        sanitizedUpdates.agentYoloDefaultsMigrated = true
      }
      if ('agentDefaultEnv' in updates) {
        sanitizedUpdates.agentDefaultEnv = normalizeTuiAgentEnvRecord(updates.agentDefaultEnv)
        sanitizedUpdates.agentYoloDefaultsMigrated = true
      }
      if ('uiLanguage' in updates) {
        sanitizedUpdates.uiLanguage = normalizeUiLanguage(updates.uiLanguage)
      }
      if ('terminalScrollbackRows' in updates) {
        sanitizedUpdates.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
          updates.terminalScrollbackRows
        )
      }
      const nextSettings = await window.api.settings.set(sanitizedUpdates)
      set((s) => ({ settings: (nextSettings as GlobalSettings | undefined) ?? s.settings }))
    } catch (err) {
      console.error('Failed to update settings:', err)
    }
  },

  setActiveRuntimeEnvironmentPreference: async (environmentId) => {
    const nextId = normalizeRuntimeEnvironmentId(environmentId)
    const previousId = normalizeRuntimeEnvironmentId(get().settings?.activeRuntimeEnvironmentId)
    if (previousId === nextId) {
      return true
    }
    try {
      clearRuntimeCompatibilityCache(nextId)
      await verifyRuntimeEnvironmentReachable(nextId)
      const nextSettings = await window.api.settings.setActiveRuntimeEnvironmentPreference({
        environmentId: nextId
      })
      bumpProviderRuntimeSessionGeneration()
      set((s) => ({
        // Why: in the multi-host model this is a focus/default-host change,
        // not a teardown boundary. Existing host-owned sessions stay alive.
        settings:
          (nextSettings as GlobalSettings | undefined) ??
          (s.settings ? { ...s.settings, activeRuntimeEnvironmentId: nextId } : null)
      }))
      // Why: hydration is host-merged by downstream slices. Switching focus
      // should add/update the selected host without discarding other hosts.
      await get().fetchRepos()
      await get().fetchAllWorktrees()
      await get().fetchWorktreeLineage()
      await get().fetchBrowserSessionProfiles()
      return true
    } catch (err) {
      console.error('Failed to switch runtime environment:', err)
      toast.error(translate('auto.store.slices.settings.e12dab333b', 'Failed to switch servers'), {
        description: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  }
})
