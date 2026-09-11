import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

export type RuntimeEnvironmentStatus = {
  snapshot?: RuntimeHostStatusSnapshot
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  appVersion?: string | null
  checkedAt: number
  connectionGeneration?: number
}

export type RuntimeStatusRefreshOptions = {
  publishUnreachable?: boolean
}

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
  refreshRuntimeEnvironmentStatus: (
    environmentId: string,
    timeoutMs?: number,
    options?: RuntimeStatusRefreshOptions
  ) => Promise<boolean>
  hydrateRuntimeEnvironmentStatuses: () => Promise<void>
}
