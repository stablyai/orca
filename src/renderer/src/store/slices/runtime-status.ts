import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { runtimeEnvironmentStatusesEqual } from './runtime-environment-status-equality'
import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache
} from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'
import {
  dismissRuntimeDisconnectedToast,
  showRuntimeDisconnectedToast
} from './runtime-environment-disconnect-toast'
import { reconcileCatalogRows } from './repo-identity-reconcile'
import { createRuntimeStatusHydration } from './runtime-status-hydration'
import { refreshRuntimeEnvironmentStatus } from './runtime-status-refresh'
import { replayClientHostedBrowserCloseIntents } from '@/runtime/client-hosted-browser-close-intent-replay'
import {
  ensureBrowserClientHostForRestartedRuntime,
  ensureBrowserClientHostsForRestoredPages
} from '@/runtime/restored-client-hosted-browser-host-attach'

/** Live status for one saved runtime environment, as last observed by the
 * renderer. `status === null` records a probe that failed or timed out so the
 * sidebar can still distinguish "unknown/unreachable" from "never checked". */
export type RuntimeEnvironmentStatus = {
  status: RuntimeStatus | null
  appVersion?: string | null
  /** When the stored status was last *observed to change*; an unchanged re-probe
   * is dropped rather than rewritten, so this is not a probe-freshness clock. */
  checkedAt: number
  connectionGeneration?: number
}

export type RuntimeStatusSlice = {
  /** Saved remote Orca servers. Host pickers use this to show user-chosen names
   * instead of opaque runtime ids. */
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
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
  setRuntimeEnvironments: (environments: readonly PublicKnownRuntimeEnvironment[]) => void
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

export function getRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  return connectionGenerationByEnvironment.get(environmentId) ?? 0
}

export const clearRuntimeEnvironmentConnectionGenerationsForTests = (): void =>
  connectionGenerationByEnvironment.clear()

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
      // Why: list()/hydrate always allocate (IPC structuredClone + redact remaps
      // endpoints[]). Reuse equal rows so Object.is subscribers don't miss 100%.
      const reconciled = reconcileCatalogRows(
        s.runtimeEnvironments,
        environments,
        (environment) => environment.id
      )
      const catalogUnchanged = reconciled === s.runtimeEnvironments
      if (
        catalogUnchanged &&
        s.runtimeEnvironmentCatalogHydrated &&
        s.runtimeEnvironmentCatalogSettled &&
        !statusesChanged &&
        !removedChanged
      ) {
        return s
      }
      return {
        runtimeEnvironments: catalogUnchanged ? s.runtimeEnvironments : reconciled,
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
    get().retainRuntimeTerminalQuickCommands?.(environments.map((environment) => environment.id))
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
    const pairedDeviceId = status.status?.pairedDeviceId?.trim()
    // A new runtime id under a known previous one is a restart, not a first connect: the guests are
    // still ours to host, but only a fresh attach hands them back to the replacement runtime.
    const runtimeRestarted = Boolean(
      status.status !== null &&
      previous?.status != null &&
      previous.status.runtimeId !== status.status.runtimeId
    )
    // Why: a non-null status proves the runtime just answered, so drop any stale
    // "offline" compat failure before this online transition fires the
    // reuse-flagged background refetches — a recovered host must re-probe.
    if (status.status !== null) {
      clearRecentRuntimeCompatibilityFailure(environmentId, status.status)
    }
    set((s) => {
      const sessionEnded = status.status === null && previous?.status != null
      const connectionChanged =
        status.status !== null &&
        (previous?.status == null || previous.status.runtimeId !== status.status.runtimeId)
      const activeEnvironmentId = s.settings?.activeRuntimeEnvironmentId?.trim()
      const connectionGeneration = connectionChanged
        ? advanceRuntimeEnvironmentConnectionGeneration(environmentId)
        : (previous?.connectionGeneration ??
          status.connectionGeneration ??
          getRuntimeEnvironmentConnectionGeneration(environmentId))
      if (activeEnvironmentId === environmentId && (sessionEnded || connectionChanged)) {
        bumpProviderRuntimeSessionGeneration()
      }
      const nextEntry = { ...status, connectionGeneration }
      const currentEntry = s.runtimeStatusByEnvironmentId.get(environmentId)
      // Why: an unchanged re-probe must not invalidate every Map subscriber. Real
      // transitions change `status` or advance `connectionGeneration`, so they still write.
      const statusUnchanged = Boolean(
        currentEntry && runtimeEnvironmentStatusesEqual(currentEntry, nextEntry)
      )
      const environmentIndex = pairedDeviceId
        ? s.runtimeEnvironments.findIndex((environment) => environment.id === environmentId)
        : -1
      const runtimeEnvironments =
        environmentIndex >= 0 &&
        s.runtimeEnvironments[environmentIndex].pairedDeviceId !== pairedDeviceId
          ? s.runtimeEnvironments.map((environment, index) =>
              index === environmentIndex ? { ...environment, pairedDeviceId } : environment
            )
          : s.runtimeEnvironments
      const environmentsChanged = runtimeEnvironments !== s.runtimeEnvironments
      if (statusUnchanged && !environmentsChanged) {
        return s
      }
      return {
        runtimeStatusByEnvironmentId: statusUnchanged
          ? s.runtimeStatusByEnvironmentId
          : new Map(s.runtimeStatusByEnvironmentId).set(environmentId, nextEntry),
        ...(environmentsChanged ? { runtimeEnvironments } : {})
      }
    })
    if (runtimeRestarted) {
      void ensureBrowserClientHostForRestartedRuntime(get(), environmentId)
    }
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

  refreshRuntimeEnvironmentStatus: (environmentId, timeoutMs = 10_000) =>
    refreshRuntimeEnvironmentStatus(environmentId, timeoutMs, (status) => {
      // Why: setRuntimeEnvironmentStatus drops any stale compat failure on a non-null
      // (reachable) status, so a recovered host's reuse-flagged refetches re-probe.
      get().setRuntimeEnvironmentStatus(environmentId, { status, checkedAt: Date.now() })
      if (status) {
        // Why here: hydration can ask before the environment is reachable, and a restored
        // client-hosted page only comes back once this desktop attaches as its host.
        void ensureBrowserClientHostsForRestoredPages(get())
        // Why alongside: the same restart that hands those rows back also restores rows the user
        // already closed while this environment was down, so the closes it never heard have to be
        // replayed before its persisted records can put them on screen again.
        void replayClientHostedBrowserCloseIntents(environmentId, get())
      }
    }),

  hydrateRuntimeEnvironmentStatuses: createRuntimeStatusHydration({
    listEnvironments: () => window.api.runtimeEnvironments.list(),
    getCurrentEnvironments: () => get().runtimeEnvironments,
    publishEnvironments: (environments) => get().setRuntimeEnvironments(environments),
    refreshEnvironmentStatus: (environmentId) =>
      get().refreshRuntimeEnvironmentStatus(environmentId),
    // Why: failed reads release catalog waiters without claiming routing is safe.
    markCatalogSettled: () => set({ runtimeEnvironmentCatalogSettled: true })
  })
})
