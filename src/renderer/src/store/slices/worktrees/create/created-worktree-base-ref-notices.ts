import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { CreatedWorktreeResult } from './worktree-create-payload'
import type { AppState } from '@/store/types'
import { showLocalBaseRefUpdateSuggestionToast } from '@/components/sidebar/workspace-creation/base-ref-update/local-base-ref-suggestion-toast'
import { requestWorktreeBaseFallbackNotice } from '@/components/sidebar/workspace-creation/base-ref-update/worktree-base-fallback-notice'
import { showLocalBaseRefRefreshToast } from './local-base-ref-refresh-toast'

type SettingsWriter = {
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  getSettings: () => GlobalSettings | null
}

function ownerSettingsWriter(owner: RuntimeClientTarget, local: SettingsWriter): SettingsWriter {
  if (owner.kind !== 'environment') {
    return local
  }
  // A host suggests keeping local main up to date only while its own switch is off.
  let saved: Partial<GlobalSettings> = { refreshLocalBaseRefOnWorktreeCreate: false }
  return {
    updateSettings: async (updates) => {
      await callRuntimeRpc(owner, 'settings.update', updates, { timeoutMs: 15_000 })
      saved = { ...saved, ...updates }
    },
    getSettings: () => {
      const settings = local.getSettings()
      return settings ? { ...settings, ...saved } : settings
    }
  }
}

/** The base-ref notices after a create; their buttons save where the create's settings live. */
export function showCreatedWorktreeBaseRefNotices(
  result: CreatedWorktreeResult,
  target: RuntimeClientTarget,
  creationHostId: ExecutionHostId,
  get: () => Pick<
    AppState,
    'updateSettings' | 'settings' | 'openSettingsPage' | 'openSettingsTarget'
  >
): void {
  // The create already learned whether the host used its own settings; older hosts used this app's.
  const owner: RuntimeClientTarget = result.hostOwnsCreateSettings ? target : { kind: 'local' }
  const state = get()
  const writer = ownerSettingsWriter(owner, {
    updateSettings: state.updateSettings,
    getSettings: () => get().settings
  })
  showLocalBaseRefRefreshToast(result.localBaseRefRefresh, result.worktree, {
    updateSettings: writer.updateSettings,
    executionHostId: creationHostId
  })
  if (result.baseFallback) {
    requestWorktreeBaseFallbackNotice(result.baseFallback)
  }
  showLocalBaseRefUpdateSuggestionToast(result.localBaseRefUpdateSuggestion, {
    ...writer,
    ...(owner.kind === 'environment' ? { settingsHostScope: owner } : {}),
    openSettingsPage: state.openSettingsPage,
    openSettingsTarget: state.openSettingsTarget
  })
}
