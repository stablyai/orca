import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppState } from '../types'

export async function persistVisibilityAwareSettings(args: {
  normalizedUpdates: Partial<GlobalSettings>
  currentSettings: GlobalSettings | null
  supportedRuntimeEnvironmentId: string | null
  sourceDefaultsSupportedRuntimeEnvironmentId?: string | null
  shouldPublish?: () => boolean
  set: (updater: (state: AppState) => Partial<AppState>) => void
}): Promise<void> {
  const {
    normalizedUpdates,
    currentSettings,
    supportedRuntimeEnvironmentId,
    sourceDefaultsSupportedRuntimeEnvironmentId = null,
    shouldPublish = () => true,
    set
  } = args
  const target = getActiveRuntimeTarget(currentSettings)
  if ('worktreeVisibilityDefaults' in normalizedUpdates && target.kind === 'environment') {
    const { worktreeVisibilityDefaults, ...localUpdates } = normalizedUpdates
    if (target.environmentId !== supportedRuntimeEnvironmentId) {
      throw new Error('Update this server to configure visibility defaults.')
    }
    if (
      worktreeVisibilityDefaults &&
      target.environmentId !== sourceDefaultsSupportedRuntimeEnvironmentId &&
      ('customSources' in worktreeVisibilityDefaults ||
        'sourcePreferences' in worktreeVisibilityDefaults)
    ) {
      throw new Error('Update this server to configure source defaults.')
    }
    const localSettings =
      Object.keys(localUpdates).length > 0
        ? ((await window.api.settings.set(localUpdates)) as GlobalSettings)
        : currentSettings
    let nextSettings = localSettings
    if (target.environmentId === supportedRuntimeEnvironmentId) {
      let result: { settings: Partial<GlobalSettings> }
      try {
        result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
          target,
          'settings.update',
          { worktreeVisibilityDefaults },
          { timeoutMs: 15_000 }
        )
      } catch (error) {
        if (localSettings && shouldPublish()) {
          set((state) => {
            const currentTarget = getActiveRuntimeTarget(state.settings)
            const stillFocused =
              currentTarget.kind === 'environment' &&
              currentTarget.environmentId === target.environmentId
            const defaults =
              state.worktreeVisibilityDefaultsByHost[
                toRuntimeExecutionHostId(target.environmentId)
              ] ?? currentSettings?.worktreeVisibilityDefaults
            return {
              settings:
                stillFocused && defaults
                  ? { ...localSettings, worktreeVisibilityDefaults: defaults }
                  : state.settings
            }
          })
        }
        throw error
      }
      nextSettings = {
        ...localSettings,
        worktreeVisibilityDefaults: result.settings.worktreeVisibilityDefaults
      } as GlobalSettings
    }
    if (!shouldPublish()) {
      return
    }
    set((state) => {
      const currentTarget = getActiveRuntimeTarget(state.settings)
      const stillFocused =
        currentTarget.kind === 'environment' && currentTarget.environmentId === target.environmentId
      return {
        settings: stillFocused ? nextSettings : state.settings,
        worktreeVisibilityDefaultsByHost:
          target.environmentId === supportedRuntimeEnvironmentId &&
          nextSettings?.worktreeVisibilityDefaults
            ? {
                ...state.worktreeVisibilityDefaultsByHost,
                [toRuntimeExecutionHostId(target.environmentId)]:
                  nextSettings.worktreeVisibilityDefaults
              }
            : state.worktreeVisibilityDefaultsByHost
      }
    })
    return
  }
  const nextSettings = await window.api.settings.set(normalizedUpdates)
  if (!shouldPublish()) {
    return
  }
  set((state) => ({
    settings: (() => {
      const persisted = (nextSettings as GlobalSettings | undefined) ?? state.settings
      if (!persisted || target.kind !== 'environment') {
        return persisted
      }
      const defaults =
        state.worktreeVisibilityDefaultsByHost[toRuntimeExecutionHostId(target.environmentId)] ??
        currentSettings?.worktreeVisibilityDefaults
      if (
        target.environmentId ===
          (state.worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId ??
            supportedRuntimeEnvironmentId) &&
        defaults
      ) {
        return { ...persisted, worktreeVisibilityDefaults: defaults }
      }
      const { worktreeVisibilityDefaults: _unsupported, ...settingsWithoutDefaults } = persisted
      return settingsWithoutDefaults as GlobalSettings
    })(),
    ...('worktreeVisibilityDefaults' in normalizedUpdates
      ? {
          worktreeVisibilityDefaultsByHost: {
            ...state.worktreeVisibilityDefaultsByHost,
            [LOCAL_EXECUTION_HOST_ID]: (nextSettings as GlobalSettings | undefined)
              ?.worktreeVisibilityDefaults ??
              normalizedUpdates.worktreeVisibilityDefaults ?? { external: 'hide' }
          }
        }
      : {})
  }))
}
