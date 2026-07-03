import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'

/** Live status for one saved runtime environment, as last observed by the
 * renderer. `status === null` records a probe that failed or timed out so the
 * sidebar can still distinguish "unknown/unreachable" from "never checked". */
export type RuntimeEnvironmentStatus = {
  status: RuntimeStatus | null
  appVersion?: string | null
  checkedAt: number
}

export type RuntimeStatusSlice = {
  /** Saved remote Orca servers. Host pickers use this to show user-chosen names
   * instead of opaque runtime ids. */
  runtimeEnvironments: PublicKnownRuntimeEnvironment[]
  /** Keyed by runtime environment id. Fed into buildExecutionHostRegistry so
   * compat verdicts/blocked health show live in the sidebar host pickers. */
  runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
  /** Replaces the saved-environment list and trims stale status entries. */
  setRuntimeEnvironments: (environments: PublicKnownRuntimeEnvironment[]) => void
  /** Merges one environment's status. Replaces the prior entry for that id. */
  setRuntimeEnvironmentStatus: (environmentId: string, status: RuntimeEnvironmentStatus) => void
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

export const createRuntimeStatusSlice: StateCreator<AppState, [], [], RuntimeStatusSlice> = (
  set,
  get
) => ({
  runtimeEnvironments: [],
  runtimeStatusByEnvironmentId: new Map(),

  setRuntimeEnvironments: (environments) => {
    set((s) => {
      const keep = new Set(environments.map((environment) => environment.id))
      const nextStatuses = new Map(s.runtimeStatusByEnvironmentId)
      let statusesChanged = false
      for (const id of nextStatuses.keys()) {
        if (!keep.has(id)) {
          nextStatuses.delete(id)
          statusesChanged = true
        }
      }
      return {
        runtimeEnvironments: environments,
        ...(statusesChanged ? { runtimeStatusByEnvironmentId: nextStatuses } : {})
      }
    })
    // Why: evict detected-agent caches for environments that no longer exist so
    // they don't leak per-environment entries for the renderer session.
    // Optional-chained: minimal store assemblies (some unit tests) omit the
    // detected-agents slice.
    get().retainRuntimeDetectedAgents?.(environments.map((environment) => environment.id))
  },

  setRuntimeEnvironmentStatus: (environmentId, status) =>
    set((s) => {
      const next = new Map(s.runtimeStatusByEnvironmentId)
      next.set(environmentId, status)
      return { runtimeStatusByEnvironmentId: next }
    }),

  clearRuntimeEnvironmentStatus: (environmentId) =>
    set((s) => {
      if (!s.runtimeStatusByEnvironmentId.has(environmentId)) {
        return s
      }
      const next = new Map(s.runtimeStatusByEnvironmentId)
      next.delete(environmentId)
      return { runtimeStatusByEnvironmentId: next }
    }),

  retainRuntimeEnvironmentStatuses: (environmentIds) =>
    set((s) => {
      const keep = new Set(environmentIds)
      let changed = false
      const next = new Map(s.runtimeStatusByEnvironmentId)
      for (const id of next.keys()) {
        if (!keep.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? { runtimeStatusByEnvironmentId: next } : s
    }),

  refreshRuntimeEnvironmentStatus: async (environmentId, timeoutMs = 10_000) => {
    try {
      const response = await window.api.runtimeEnvironments.getStatus({
        selector: environmentId,
        timeoutMs
      })
      const status = unwrapRuntimeRpcResult<RuntimeStatus>(response)
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
