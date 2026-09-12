import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'

export type RuntimeEnvironmentStatus = {
  snapshot?: RuntimeHostStatusSnapshot
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  appVersion?: string | null
  checkedAt: number
  /**
   * Identity of the connection: which socket epoch retained state belongs to. Every cache key,
   * stamp and settle fence compares this, so advancing it invalidates the session mirror.
   */
  connectionGeneration?: number
  /**
   * Edge count of "the host answered again after we lost contact". A resubscribe trigger only —
   * the streams died with the transport and nothing else revives them. Never an identity, a cache
   * key, or a fence: that is `connectionGeneration`, and a flap must not move it (#19647).
   */
  hostContactEpoch?: number
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
  refreshRuntimeEnvironmentStatus: (environmentId: string, timeoutMs?: number) => Promise<boolean>
  hydrateRuntimeEnvironmentStatuses: () => Promise<void>
}
