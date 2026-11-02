import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { AppState } from '../types'

export type { RuntimeEnvironmentStatus }

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
  refreshRuntimeEnvironmentStatus: (environmentId: string, timeoutMs?: number) => Promise<boolean>
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
      | 'retainRuntimeTerminalQuickCommands'
      | 'retainEnvironmentSshState'
      | 'clearRuntimeDetectedAgents'
      | 'markEnvironmentSshStateStale'
      | 'purgeStaleRuntimeHostState'
    >
  >

export type RuntimeStatusStoreSetState = (
  partial:
    | Partial<RuntimeStatusStoreState>
    | ((state: RuntimeStatusStoreState) => Partial<RuntimeStatusStoreState>)
) => void
