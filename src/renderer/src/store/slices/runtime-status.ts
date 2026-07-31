import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  unwrapRuntimeRpcResult
} from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { translate } from '@/i18n/i18n'

/** Live status for one saved runtime environment, as last observed by the
 * renderer. `status === null` records a probe that failed or timed out so the
 * sidebar can still distinguish "unknown/unreachable" from "never checked". */
export type RuntimeEnvironmentStatus = {
  status: RuntimeStatus | null
  appVersion?: string | null
  checkedAt: number
  connectionGeneration?: number
}

export type RuntimeStatusSlice = {
  /** Saved remote Orca servers. Host pickers use this to show user-chosen names
   * instead of opaque runtime ids. */
  runtimeEnvironments: PublicKnownRuntimeEnvironment[]
  /** True only after the saved-runtime catalog has loaded successfully. Gates
   * fail-closed host routing, so a failed read must NOT flip it. */
  runtimeEnvironmentCatalogHydrated: boolean
  /** True once the catalog read has finished, successfully or not. Surfaces that
   * only need to stop waiting (skill discovery) read this instead of
   * `runtimeEnvironmentCatalogHydrated`, so a failed read degrades rather than
   * leaving them pending for the whole session. */
  runtimeEnvironmentCatalogSettled: boolean
  /** Keyed by runtime environment id. Fed into buildExecutionHostRegistry so
   * compat verdicts/blocked health show live in the sidebar host pickers. */
  runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
  /** Tombstones of runtime environment ids that were removed from the saved list
   * this session and not yet re-added. Distinct from "absent from
   * `runtimeEnvironments`", which also matches not-yet-hydrated envs — a
   * catalog-merge guard keyed on mere absence would drop legitimate runtime repos
   * during boot before the saved list hydrates (#8881). */
  removedRuntimeEnvironmentIds: ReadonlySet<string>
  /** Replaces the saved-environment list, trims stale status entries, and
   * retires state owned by any environment that just left the saved list. */
  setRuntimeEnvironments: (environments: PublicKnownRuntimeEnvironment[]) => void
  /** Merges one environment's status. Replaces the prior entry for that id. */
  setRuntimeEnvironmentStatus: (
    environmentId: string,
    status: RuntimeEnvironmentStatus,
    options?: { suppressDisconnectToast?: boolean }
  ) => void
  /** Drops a removed environment so stale hosts don't linger in the registry. */
  clearRuntimeEnvironmentStatus: (environmentId: string) => void
  /** Drops every entry whose id is not in the saved-environments set. */
  retainRuntimeEnvironmentStatuses: (environmentIds: Iterable<string>) => void
  /** Probes one saved runtime and records the latest reachable/unreachable state. */
  refreshRuntimeEnvironmentStatus: (environmentId: string, timeoutMs?: number) => Promise<boolean>
  /** Best-effort: list saved environments and probe each so the sidebar shows
   * live health at boot, before the settings pane is ever opened. */
  hydrateRuntimeEnvironmentStatuses: () => Promise<void>
}

const connectionGenerationByEnvironment = new Map<string, number>()
const activeRuntimeDisconnectedToasts = new Map<string, symbol>()
const RUNTIME_DISCONNECTED_TOAST_DURATION_MS = 4_000

function getRuntimeDisconnectedToastId(environmentId: string): string {
  return `runtime-environment-disconnected:${environmentId}`
}

function showRuntimeDisconnectedToast(environmentId: string, getState: () => AppState): void {
  const environment = getState().runtimeEnvironments.find((entry) => entry.id === environmentId)
  const toastId = getRuntimeDisconnectedToastId(environmentId)
  const activation = Symbol(toastId)
  const title = environment?.name
    ? translate(
        'auto.store.slices.runtime.status.runtimeHostUnreachableNamed',
        "Can't reach {{hostName}}",
        { hostName: environment.name }
      )
    : translate(
        'auto.store.slices.runtime.status.runtimeHostUnreachable',
        "Can't reach Orca server"
      )
  activeRuntimeDisconnectedToasts.set(toastId, activation)
  const clearActiveToast = (): void => {
    if (activeRuntimeDisconnectedToasts.get(toastId) === activation) {
      activeRuntimeDisconnectedToasts.delete(toastId)
    }
  }
  let retrying = false
  const showToast = (duration = RUNTIME_DISCONNECTED_TOAST_DURATION_MS): void => {
    toast.warning(title, {
      id: toastId,
      description: translate(
        'auto.store.slices.runtime.status.runtimeHostDisconnectedDescription',
        'Check that Orca is running on this server and that your network connection is working, then try again.'
      ),
      duration,
      action: {
        label: translate('auto.store.slices.runtime.status.tryAgain', 'Try again'),
        onClick: (event) => {
          // Why: Sonner otherwise deletes the keyed toast after the action callback.
          event.preventDefault()
          if (retrying) {
            return
          }
          retrying = true
          showToast(Number.POSITIVE_INFINITY)
          void getState()
            .refreshRuntimeEnvironmentStatus(environmentId)
            .then((reachable) => {
              const stillSaved = getState().runtimeEnvironments.some(
                (entry) => entry.id === environmentId
              )
              if (
                !reachable &&
                stillSaved &&
                activeRuntimeDisconnectedToasts.get(toastId) === activation
              ) {
                showToast()
              }
            })
            .finally(() => {
              retrying = false
            })
        }
      },
      onDismiss: clearActiveToast,
      onAutoClose: clearActiveToast
    })
  }
  showToast()
}

function dismissRuntimeDisconnectedToast(environmentId: string): void {
  const toastId = getRuntimeDisconnectedToastId(environmentId)
  if (!activeRuntimeDisconnectedToasts.delete(toastId)) {
    return
  }
  toast.dismiss?.(toastId)
}

export function getRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  return connectionGenerationByEnvironment.get(environmentId) ?? 0
}

function advanceRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  const next = getRuntimeEnvironmentConnectionGeneration(environmentId) + 1
  connectionGenerationByEnvironment.set(environmentId, next)
  return next
}

export const createRuntimeStatusSlice: StateCreator<AppState, [], [], RuntimeStatusSlice> = (
  set,
  get
) => ({
  runtimeEnvironments: [],
  runtimeEnvironmentCatalogHydrated: false,
  runtimeEnvironmentCatalogSettled: false,
  runtimeStatusByEnvironmentId: new Map(),
  removedRuntimeEnvironmentIds: new Set(),

  setRuntimeEnvironments: (environments) => {
    const previousRevisionById = new Map(
      get().runtimeEnvironments.map((environment) => [
        environment.id,
        environment.pairingRevision ?? environment.createdAt
      ])
    )
    const replacedEnvironmentIds = environments
      .filter((environment) => {
        const previousRevision = previousRevisionById.get(environment.id)
        return (
          previousRevision !== undefined &&
          previousRevision !== (environment.pairingRevision ?? environment.createdAt)
        )
      })
      .map((environment) => environment.id)
    replaceRuntimeEnvironmentRevisions(environments)
    // Why: diff against the accumulated in-memory saved list (not a second disk
    // read) so a main-initiated removal that never calls setRuntimeEnvironments
    // still enters the diff on the next list read. #8881.
    const nextIds = new Set(environments.map((environment) => environment.id))
    const removedIds = get()
      .runtimeEnvironments.map((environment) => environment.id)
      .filter((id) => !nextIds.has(id))
    set((s) => {
      const keep = new Set(environments.map((environment) => environment.id))
      const nextStatuses = new Map(s.runtimeStatusByEnvironmentId)
      let statusesChanged = false
      for (const id of nextStatuses.keys()) {
        if (!keep.has(id)) {
          nextStatuses.delete(id)
          advanceRuntimeEnvironmentConnectionGeneration(id)
          statusesChanged = true
        }
      }
      for (const id of replacedEnvironmentIds) {
        if (nextStatuses.delete(id)) {
          statusesChanged = true
        }
        advanceRuntimeEnvironmentConnectionGeneration(id)
      }
      // Add just-removed ids as tombstones and clear any that were re-added, so an
      // in-flight catalog merge for a removed env can be dropped without mistaking a
      // not-yet-hydrated env for a removed one (#8881).
      const nextRemoved = new Set(s.removedRuntimeEnvironmentIds)
      let removedChanged = false
      for (const id of removedIds) {
        if (!nextRemoved.has(id)) {
          nextRemoved.add(id)
          removedChanged = true
        }
      }
      for (const id of nextIds) {
        if (nextRemoved.delete(id)) {
          removedChanged = true
        }
      }
      return {
        runtimeEnvironments: environments,
        runtimeEnvironmentCatalogHydrated: true,
        runtimeEnvironmentCatalogSettled: true,
        ...(statusesChanged ? { runtimeStatusByEnvironmentId: nextStatuses } : {}),
        ...(removedChanged ? { removedRuntimeEnvironmentIds: nextRemoved } : {})
      }
    })
    // Why: evict detected-agent caches for environments that no longer exist so
    // they don't leak per-environment entries for the renderer session.
    // Optional-chained: minimal store assemblies (some unit tests) omit the
    // detected-agents slice.
    get().retainRuntimeDetectedAgents?.(environments.map((environment) => environment.id))
    // A detached environment's mirrored SSH state must not outlive it.
    get().retainEnvironmentSshState?.(environments.map((environment) => environment.id))
    for (const id of replacedEnvironmentIds) {
      clearRuntimeCompatibilityCache(id)
      get().markEnvironmentSshStateStale?.(id)
    }
    // Why: same-id re-pair publications belong to the retired peer just as surely as removed ids.
    const retiredEnvironmentIds = [...new Set([...removedIds, ...replacedEnvironmentIds])]
    if (retiredEnvironmentIds.length > 0) {
      get().purgeStaleRuntimeHostState?.(retiredEnvironmentIds)
      retiredEnvironmentIds.forEach(dismissRuntimeDisconnectedToast)
    }
  },

  setRuntimeEnvironmentStatus: (environmentId, status, options) => {
    const previous = get().runtimeStatusByEnvironmentId.get(environmentId)
    // Why: a non-null status proves the runtime just answered, so drop any stale
    // "offline" compat failure before this online transition fires the
    // reuse-flagged background refetches — a recovered host must re-probe.
    if (status.status !== null) {
      clearRecentRuntimeCompatibilityFailure(environmentId, status.status)
    }
    set((s) => {
      const next = new Map(s.runtimeStatusByEnvironmentId)
      const connectionChanged =
        status.status !== null &&
        (previous?.status == null || previous.status.runtimeId !== status.status.runtimeId)
      if (connectionChanged) {
        advanceRuntimeEnvironmentConnectionGeneration(environmentId)
      }
      next.set(environmentId, {
        ...status,
        connectionGeneration: connectionChanged
          ? (previous?.connectionGeneration ?? 0) + 1
          : (previous?.connectionGeneration ?? status.connectionGeneration ?? 0)
      })
      return { runtimeStatusByEnvironmentId: next }
    })
    if (options?.suppressDisconnectToast) {
      dismissRuntimeDisconnectedToast(environmentId)
    } else if (previous?.status === null && status.status !== null) {
      dismissRuntimeDisconnectedToast(environmentId)
    } else if (previous && previous.status !== null && status.status === null) {
      showRuntimeDisconnectedToast(environmentId, get)
    }
  },

  clearRuntimeEnvironmentStatus: (environmentId) => {
    dismissRuntimeDisconnectedToast(environmentId)
    set((s) => {
      advanceRuntimeEnvironmentConnectionGeneration(environmentId)
      if (!s.runtimeStatusByEnvironmentId.has(environmentId)) {
        return s
      }
      const next = new Map(s.runtimeStatusByEnvironmentId)
      next.delete(environmentId)
      return { runtimeStatusByEnvironmentId: next }
    })
  },

  retainRuntimeEnvironmentStatuses: (environmentIds) => {
    const keep = new Set(environmentIds)
    for (const id of get().runtimeStatusByEnvironmentId.keys()) {
      if (!keep.has(id)) {
        dismissRuntimeDisconnectedToast(id)
      }
    }
    set((s) => {
      let changed = false
      const next = new Map(s.runtimeStatusByEnvironmentId)
      for (const id of next.keys()) {
        if (!keep.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? { runtimeStatusByEnvironmentId: next } : s
    })
  },

  refreshRuntimeEnvironmentStatus: async (environmentId, timeoutMs = 10_000) => {
    try {
      const response = await window.api.runtimeEnvironments.getStatus({
        selector: environmentId,
        timeoutMs
      })
      const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
      // setRuntimeEnvironmentStatus drops any stale compat failure on a non-null
      // (reachable) status, so a recovered host's reuse-flagged refetches re-probe.
      get().setRuntimeEnvironmentStatus(environmentId, { status, checkedAt: Date.now() })
      return true
    } catch {
      get().setRuntimeEnvironmentStatus(environmentId, {
        status: null,
        checkedAt: Date.now()
      })
      return false
    }
  },

  hydrateRuntimeEnvironmentStatuses: async () => {
    let environments: PublicKnownRuntimeEnvironment[]
    try {
      environments = await window.api.runtimeEnvironments.list()
    } catch (err) {
      console.error('Failed to list runtime environments for status hydration:', err)
      // Why: settled, not hydrated. Skill discovery must stop waiting and fall
      // back to the local host, but host routing keeps failing closed on an
      // unknown catalog rather than acting on a stale empty list.
      set({ runtimeEnvironmentCatalogSettled: true })
      return
    }
    get().setRuntimeEnvironments(environments)
    // Why: fire-and-forget per env; one unreachable server must not block the
    // others, and a failure records a null status rather than nothing.
    await Promise.allSettled(
      environments.map((environment) => get().refreshRuntimeEnvironmentStatus(environment.id))
    )
  }
})
