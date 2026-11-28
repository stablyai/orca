import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { AppState } from '../../types'

export type RuntimeStatusSlice = {
  readRuntimeHostStatusSnapshots: () => Promise<void>
  applyRuntimeHostStatusSnapshot: (snapshot: RuntimeHostStatusSnapshot) => void
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  runtimeEnvironmentCatalogHydrated: boolean
  runtimeEnvironmentCatalogSettled: boolean
  runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
  removedRuntimeEnvironmentIds: ReadonlySet<string>
  setRuntimeEnvironments: (environments: readonly PublicKnownRuntimeEnvironment[]) => void
  setRuntimeEnvironmentStatus: (
    environmentId: string,
    status: RuntimeEnvironmentStatus,
    options?: { suppressDisconnectToast?: boolean }
  ) => void
  clearRuntimeEnvironmentStatus: (environmentId: string) => void
  retainRuntimeEnvironmentStatuses: (environmentIds: Iterable<string>) => void
  /** `force` is for a check the user asked for; background refreshes respect the host's failure backoff. */
  refreshRuntimeEnvironmentStatus: (
    environmentId: string,
    timeoutMs?: number,
    options?: { force?: true }
  ) => Promise<boolean>
  hydrateRuntimeEnvironmentStatuses: () => Promise<void>
}

export type RuntimeStatusStoreState = RuntimeStatusSlice &
  Pick<
    AppState,
    'clientHostedBrowserCloseIntentsByEnvironment' | 'clearClientHostedBrowserCloseIntents'
  > &
  Partial<
    Pick<
      AppState,
      | 'settings'
      | 'remoteBrowserPageHandlesByPageId'
      | 'retainRuntimeDetectedAgents'
      | 'setRuntimeAgentOrchestrationByPaneKey'
      | 'retainRuntimeTerminalQuickCommands'
      | 'retainEnvironmentSshState'
      | 'clearRuntimeDetectedAgents'
      | 'markEnvironmentSshStateStale'
      | 'purgeStaleRuntimeHostState'
      | 'forgetAgentCliUpdateHosts'
      | 'clearHostWorkspaceStatuses'
      | 'pairedTerminalTabCloseIntentsByEnvironment'
      | 'recordPairedTerminalTabCloseIntent'
      | 'clearPairedTerminalTabCloseIntents'
    >
  >

export type RuntimeStatusStoreSetState = (
  partial:
    | Partial<RuntimeStatusStoreState>
    | ((state: RuntimeStatusStoreState) => Partial<RuntimeStatusStoreState>)
) => void
