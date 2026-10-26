import type {
  RuntimeStatusSlice,
  RuntimeStatusStoreSetState,
  RuntimeStatusStoreState
} from './runtime-status-types'
export type { RuntimeEnvironmentStatus, RuntimeStatusSlice } from './runtime-status-types'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { runtimeEnvironmentStatusesEqual } from './runtime-environment-status-equality'
import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache
} from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { bumpProviderRuntimeSessionGeneration } from '@/lib/provider-runtime-context'
import { evictInstalledAgentSkillDiscoveryForRuntimeEnvironments } from '@/hooks/installed-agent-skill-discovery'
import {
  dismissRuntimeDisconnectedToast,
  showRuntimeDisconnectedToast
} from './runtime-environment-disconnect-toast'
import { reconcileCatalogRows } from '../../../../shared/catalog-row-reconcile'
import { createRuntimeStatusHydration } from './runtime-status-hydration'
import { refreshRuntimeEnvironmentStatus } from './runtime-status-refresh'
import * as runtimeStatusConnectionGeneration from './runtime-status-connection-generation'
import { replayClientHostedBrowserCloseIntents } from '@/runtime/client-hosted-browser-close-intent-replay'
import {
  pairedTerminalTabCloseIntentStoreOf,
  reconcileWebSessionCloseReplaysWithCatalog
} from '@/runtime/web-session-close-replay'
import {
  ensureBrowserClientHostOnRuntimeContact,
  ensureBrowserClientHostsForRestoredPages
} from '@/runtime/restored-client-hosted-browser-host-attach'
import { applyRuntimeHostStatusSnapshot, snapshotOutrunsCatalog } from './runtime-status-snapshot'
import { refreshRuntimeEnvironmentCatalog } from '@/runtime/runtime-environment-pairing-refresh'
import {
  classifyPeerReplacements,
  replacedRuntimeEnvironmentIds
} from './runtime-environment-peer-replacement'

export const clearRuntimeEnvironmentConnectionGenerationsForTests = (): void => {
  runtimeStatusConnectionGeneration.clearRuntimeEnvironmentConnectionGenerations()
}

export {
  getRuntimeEnvironmentConnectionGeneration,
  setRuntimeEnvironmentConnectionGenerationForTests
} from './runtime-status-connection-generation'

export const createRuntimeStatusSlice: (
  set: RuntimeStatusStoreSetState,
  get: () => RuntimeStatusStoreState,
  store?: unknown
) => RuntimeStatusSlice = (set, get) => ({
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
    const previousEnvironments = get().runtimeEnvironments
    const replacedEnvironmentIds = replacedRuntimeEnvironmentIds(previousEnvironments, environments)
    const peerReplacement = classifyPeerReplacements(
      previousEnvironments,
      environments,
      replacedEnvironmentIds
    )
    // Fence replaced-peer transports before publishing revisions; only proven same-host rotations may continue.
    replaceRuntimeEnvironmentRevisions(environments, peerReplacement)
    // Diff accumulated in-memory state so main-initiated removals reach the purge on the next list read (#8881).
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
      // Tombstone removed IDs, clearing re-added ones, to reject late catalog merges without mistaking pre-hydration absence for removal (#8881).
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
      // IPC clones and endpoint redaction allocate equal rows; reconcile to preserve subscriber identity.
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
    // Prune removed environments’ agent/command caches; partial test stores may omit these slices.
    get().retainRuntimeDetectedAgents?.(environments.map((environment) => environment.id))
    get().retainRuntimeTerminalQuickCommands?.(environments.map((environment) => environment.id))
    // A detached environment's mirrored SSH state must not outlive it.
    get().retainEnvironmentSshState?.(environments.map((environment) => environment.id))
    for (const id of replacedEnvironmentIds) {
      clearRuntimeCompatibilityCache(id)
      get().clearRuntimeDetectedAgents?.(id)
      get().markEnvironmentSshStateStale?.(id)
    }
    // Why: a same-id re-pair to another peer retires it as surely as a removal.
    const retiredEnvironmentIds = [...new Set([...removedIds, ...peerReplacement.retired])]
    if (retiredEnvironmentIds.length > 0) {
      evictInstalledAgentSkillDiscoveryForRuntimeEnvironments(retiredEnvironmentIds)
      get().purgeStaleRuntimeHostState?.(retiredEnvironmentIds)
      retiredEnvironmentIds.forEach(dismissRuntimeDisconnectedToast)
    }
    reconcileWebSessionCloseReplaysWithCatalog(pairedTerminalTabCloseIntentStoreOf(get), {
      listed: nextIds,
      ...peerReplacement
    })
  },

  applyRuntimeHostStatusSnapshot: (snapshot) => {
    const apply = (): void =>
      applyRuntimeHostStatusSnapshot(snapshot, get(), (entry) => {
        set((s) => ({
          runtimeStatusByEnvironmentId: new Map(s.runtimeStatusByEnvironmentId).set(
            snapshot.environmentId,
            entry
          )
        }))
      })
    if (snapshotOutrunsCatalog(snapshot, get())) {
      // Applied once after the re-read; a catalog that is still behind drops it as before.
      void refreshRuntimeEnvironmentCatalog().then(apply)
      return
    }
    apply()
  },

  setRuntimeEnvironmentStatus: (environmentId, status, options) => {
    const previous = get().runtimeStatusByEnvironmentId.get(environmentId)
    if (previous?.snapshot && !status.snapshot) {
      return
    }
    const previousVerifiedStatus = lastVerifiedRuntimeStatus(previous)
    const pairedDeviceId = status.status?.pairedDeviceId?.trim()
    // Changed runtime ID means restart: reattach to return our client-hosted browsers to the replacement runtime.
    const runtimeRestarted = Boolean(
      status.status !== null &&
      previousVerifiedStatus != null &&
      previousVerifiedStatus.runtimeId !== status.status.runtimeId
    )
    // An outage past the browser-host lease grace drops this desktop's hosting, so regained contact
    // must re-claim it just like a restart does.
    const contactRegained = previous?.status === null && status.status !== null
    // Reachable status clears offline compatibility failures before reuse-flagged refetches can pin them.
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
      // First publication has no prior connection; advancing its fence would discard same-connection startup scans (#19241).
      const connectionChanged = previous !== undefined && runtimeSessionStarted
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
      // Same-runtime recovery preserves mirror generation; advance a separate epoch to reinstall streams that ended with transport loss.
      const hostContactEpoch =
        (previous?.hostContactEpoch ?? status.hostContactEpoch ?? 0) + (contactRegained ? 1 : 0)
      // Provider readiness tracks session start, including first publication, rather than connection changes alone.
      if (activeEnvironmentId === environmentId && (sessionEnded || runtimeSessionStarted)) {
        bumpProviderRuntimeSessionGeneration()
      }
      const nextEntry = { ...status, connectionGeneration, hostContactEpoch }
      const currentEntry = s.runtimeStatusByEnvironmentId.get(environmentId)
      // Preserve map identity for unchanged probes; real status/counter transitions still publish.
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
    if (runtimeRestarted || contactRegained) {
      void ensureBrowserClientHostOnRuntimeContact(get(), environmentId)
    }
    if (options?.suppressDisconnectToast) {
      dismissRuntimeDisconnectedToast(environmentId)
    } else if (contactRegained) {
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
        get().setRuntimeEnvironmentStatus(environmentId, entry)
        if (entry.status) {
          // Early hydration may precede reachability; restored client pages need this desktop to attach as host.
          void ensureBrowserClientHostsForRestoredPages(get())
          // Replay closes missed during downtime before restored runtime records can reopen those tabs.
          const {
            clientHostedBrowserCloseIntentsByEnvironment,
            clearClientHostedBrowserCloseIntents
          } = get()
          void replayClientHostedBrowserCloseIntents(environmentId, {
            clientHostedBrowserCloseIntentsByEnvironment,
            clearClientHostedBrowserCloseIntents
          })
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
