import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RuntimeStatusSlice } from './runtime-status-types'
export type { RuntimeEnvironmentStatus, RuntimeStatusSlice } from './runtime-status-types'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
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
import * as runtimeStatusConnectionGeneration from './runtime-status-connection-generation'
import { replayClientHostedBrowserCloseIntents } from '@/runtime/client-hosted-browser-close-intent-replay'
import {
  ensureBrowserClientHostForRestartedRuntime,
  ensureBrowserClientHostsForRestoredPages
} from '@/runtime/restored-client-hosted-browser-host-attach'
import { applyRuntimeHostStatusSnapshot } from './runtime-status-snapshot'

export const clearRuntimeEnvironmentConnectionGenerationsForTests = (): void => {
  runtimeStatusConnectionGeneration.clearRuntimeEnvironmentConnectionGenerations()
}

export {
  getRuntimeEnvironmentConnectionGeneration,
  setRuntimeEnvironmentConnectionGenerationForTests
} from './runtime-status-connection-generation'

export const createRuntimeStatusSlice: StateCreator<AppState, [], [], RuntimeStatusSlice> = (
  set,
  get
) => ({
  runtimeEnvironments: [],
  runtimeEnvironmentCatalogHydrated: false,
  runtimeEnvironmentCatalogSettled: false,
  runtimeStatusByEnvironmentId: new Map(),
  removedRuntimeEnvironmentIds: new Set(),

  readRuntimeHostStatusSnapshots: async () => {
    try {
      const snapshots = await window.api.runtimeEnvironments.getStatusSnapshots()
      snapshots.forEach((snapshot) => get().applyRuntimeHostStatusSnapshot(snapshot))
    } catch (error) {
      console.error('Failed to read runtime host status:', error)
    }
  },

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
          runtimeStatusConnectionGeneration.advanceRuntimeEnvironmentConnectionGeneration(id)
          statusesChanged = true
        }
      }
      for (const id of replacedEnvironmentIds) {
        if (nextStatuses.delete(id)) {
          statusesChanged = true
        }
        runtimeStatusConnectionGeneration.advanceRuntimeEnvironmentConnectionGeneration(id)
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

  applyRuntimeHostStatusSnapshot: (snapshot) =>
    applyRuntimeHostStatusSnapshot(snapshot, get(), (entry) => {
      set((s) => ({
        runtimeStatusByEnvironmentId: new Map(s.runtimeStatusByEnvironmentId).set(
          snapshot.environmentId,
          entry
        )
      }))
    }),

  setRuntimeEnvironmentStatus: (environmentId, status, options) => {
    const previous = get().runtimeStatusByEnvironmentId.get(environmentId)
    if (previous?.snapshot && !status.snapshot) {
      return
    }
    const previousVerifiedStatus = lastVerifiedRuntimeStatus(previous)
    const pairedDeviceId = status.status?.pairedDeviceId?.trim()
    // A new runtime id under a known previous one is a restart, not a first connect: the guests are
    // still ours to host, but only a fresh attach hands them back to the replacement runtime.
    const runtimeRestarted = Boolean(
      status.status !== null &&
      previousVerifiedStatus != null &&
      previousVerifiedStatus.runtimeId !== status.status.runtimeId
    )
    // Why: a non-null status proves the runtime just answered, so drop any stale
    // "offline" compat failure before this online transition fires the
    // reuse-flagged background refetches — a recovered host must re-probe.
    if (status.status !== null) {
      clearRecentRuntimeCompatibilityFailure(environmentId, status.status)
    }
    set((s) => {
      const sessionEnded = status.status === null && previous?.status != null
      // A reachable answer where we held none (never asked, or recorded unreachable) or
      // where the runtime id moved starts a runtime session.
      const runtimeSessionStarted =
        status.status !== null &&
        (previousVerifiedStatus == null ||
          previousVerifiedStatus.runtimeId !== status.status.runtimeId)
      // Why narrower than the session start: a first publication has no prior connection to
      // differ from, so it is not a reconnect. Advancing the generation there retires reads
      // already issued against this very connection — a startup worktree scan that had
      // already answered was discarded, leaving those repos absent until an unrelated
      // refresh (#19241).
      // Why also on a same-runtime return: regaining contact is a new connection epoch, and
      // it is the session mirror's "the host is back" trigger. The mirror used to be rebuilt
      // as a side effect of having been destroyed when contact was lost; now that it is held
      // through the outage, only this edge restores its subscription.
      const reconnectedAfterLostContact = status.status !== null && previous?.status === null
      const connectionChanged =
        previous !== undefined && (runtimeSessionStarted || reconnectedAfterLostContact)
      const activeEnvironmentId = s.settings?.activeRuntimeEnvironmentId?.trim()
      const connectionGeneration = connectionChanged
        ? runtimeStatusConnectionGeneration.advanceRuntimeEnvironmentConnectionGeneration(
            environmentId
          )
        : (previous?.connectionGeneration ??
          status.connectionGeneration ??
          runtimeStatusConnectionGeneration.getRuntimeEnvironmentConnectionGeneration(
            environmentId
          ))
      // Why the session flag and not `connectionChanged`: integration-readiness caches key
      // off the runtime session, for which a first publication is a real transition.
      if (activeEnvironmentId === environmentId && (sessionEnded || runtimeSessionStarted)) {
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
      runtimeStatusConnectionGeneration.advanceRuntimeEnvironmentConnectionGeneration(environmentId)
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
    refreshRuntimeEnvironmentStatus(
      environmentId,
      timeoutMs,
      (entry) => {
        // A null entry with no snapshot only ever comes from a status.get that threw — an
        // unverifiable transport failure, never a host-answered "gone". Publishing it would fire
        // the disconnect toast and retire the host's session-tabs mirror while its established
        // flows are still delivering. Keep the live verdict; the connection's status owner (#20003)
        // holds the last verdict and retries until a real answer. A first-contact failure (no prior
        // live status) still records null so host coverage completes. #19647
        if (entry.status === null && get().runtimeStatusByEnvironmentId.get(environmentId)?.status) {
          return
        }
        // Why: setRuntimeEnvironmentStatus drops any stale compat failure on a non-null
        // (reachable) status, so a recovered host's reuse-flagged refetches re-probe.
        get().setRuntimeEnvironmentStatus(environmentId, entry)
        if (entry.status) {
          // Why here: hydration can ask before the environment is reachable, and a restored
          // client-hosted page only comes back once this desktop attaches as its host.
          void ensureBrowserClientHostsForRestoredPages(get())
          // Why alongside: the same restart that hands those rows back also restores rows the user
          // already closed while this environment was down, so the closes it never heard have to be
          // replayed before its persisted records can put them on screen again.
          void replayClientHostedBrowserCloseIntents(environmentId, get())
        }
      },
      (snapshot) => get().applyRuntimeHostStatusSnapshot(snapshot)
    ),

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
