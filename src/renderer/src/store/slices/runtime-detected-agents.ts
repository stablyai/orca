import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  callRuntimeAgentDetection,
  RuntimeAgentDetectionNeedsServerUpdateError
} from './runtime-workspace-agent-detection'
import {
  getRuntimeAgentInventoryEnvironmentId,
  getRuntimeAgentInventoryKey
} from './runtime-agent-inventory-key'
import {
  captureRuntimeAgentDetectionOwner,
  runtimeAgentDetectionCacheMatchesOwner,
  runtimeAgentDetectionOwnerIsCurrent,
  runtimeAgentDetectionOwnerKey,
  type RuntimeAgentDetectionOwner
} from '@/runtime/runtime-agent-detection-owner'

// Why: remote runtime hosts are not SSH connections, but their launch surfaces
// (tab bar, quick launch, Settings → Agents under an Active Server) still have
// to probe the host where the workspace actually runs.
// Records are keyed by getRuntimeAgentInventoryKey: the environment alone for
// the host-default list, or environment + workspace for a workspace's list.
export type RuntimeDetectedAgentsSlice = {
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  /** Which pairing produced each record, so a re-paired host never shows its predecessor's list. */
  runtimeDetectedAgentOwnerKeys: Record<string, string>
  isDetectingRuntimeAgents: Record<string, boolean>
  isRefreshingRuntimeAgents: Record<string, boolean>
  /** Keys whose host is too old to list that workspace's agents; their list is empty. */
  runtimeAgentDetectionNeedsServerUpdate: Record<string, boolean>
  ensureRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null,
    expectedPairingRevision?: number
  ) => Promise<TuiAgent[]>
  /** Forces a re-detect on the runtime host via `preflight.refreshAgents`
   *  (login-shell PATH re-read), falling back to `preflight.detectAgents` for
   *  servers that predate the refresh RPC. */
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null,
    expectedPairingRevision?: number
  ) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
  /** Drops runtime detected-agent caches for environments not in the kept set.
   *  Wired into setRuntimeEnvironments so removed environments don't leak their
   *  detected-agent entries for the renderer session. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
type PendingDetection = { owner: RuntimeAgentDetectionOwner; promise: Promise<TuiAgent[]> }
const runtimeDetectPromises = new Map<string, PendingDetection>()
const runtimeRefreshPromises = new Map<string, PendingDetection>()

// Why: a same-id re-pair must neither join nor be settled by the retired pairing's probe.
function pendingDetectionKey(key: string, ownerKey: string): string {
  return JSON.stringify([key, ownerKey])
}

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export function _getRuntimeDetectPromiseCountForTest(): number {
  return runtimeDetectPromises.size
}

function withoutKeys<T>(record: Record<string, T>, drop: (key: string) => boolean) {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (drop(key)) {
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : record
}

export const createRuntimeDetectedAgentsSlice: StateCreator<
  AppState,
  [],
  [],
  RuntimeDetectedAgentsSlice
> = (set, get) => {
  // Drops every workspace's inventory for the environments `drop` selects.
  const dropEnvironments = (drop: (environmentId: string) => boolean): void => {
    const dropKey = (key: string) => drop(getRuntimeAgentInventoryEnvironmentId(key))
    for (const promises of [runtimeDetectPromises, runtimeRefreshPromises]) {
      for (const [key, pending] of promises) {
        if (drop(pending.owner.environmentId)) {
          promises.delete(key)
        }
      }
    }
    set((s) => {
      const runtimeDetectedAgentIds = withoutKeys(s.runtimeDetectedAgentIds, dropKey)
      const runtimeDetectedAgentOwnerKeys = withoutKeys(s.runtimeDetectedAgentOwnerKeys, dropKey)
      const isDetectingRuntimeAgents = withoutKeys(s.isDetectingRuntimeAgents, dropKey)
      const isRefreshingRuntimeAgents = withoutKeys(s.isRefreshingRuntimeAgents, dropKey)
      const runtimeAgentDetectionNeedsServerUpdate = withoutKeys(
        s.runtimeAgentDetectionNeedsServerUpdate,
        dropKey
      )
      return runtimeDetectedAgentIds === s.runtimeDetectedAgentIds &&
        runtimeDetectedAgentOwnerKeys === s.runtimeDetectedAgentOwnerKeys &&
        isDetectingRuntimeAgents === s.isDetectingRuntimeAgents &&
        isRefreshingRuntimeAgents === s.isRefreshingRuntimeAgents &&
        runtimeAgentDetectionNeedsServerUpdate === s.runtimeAgentDetectionNeedsServerUpdate
        ? s
        : {
            runtimeDetectedAgentIds,
            runtimeDetectedAgentOwnerKeys,
            isDetectingRuntimeAgents,
            isRefreshingRuntimeAgents,
            runtimeAgentDetectionNeedsServerUpdate
          }
    })
  }

  // Commits a settled detection; an old host commits an empty list, never its default.
  const commitDetection = (key: string, agents: TuiAgent[], needsServerUpdate: boolean): void => {
    set((s) => ({
      runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [key]: agents },
      isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: false },
      isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [key]: false },
      runtimeAgentDetectionNeedsServerUpdate: needsServerUpdate
        ? { ...s.runtimeAgentDetectionNeedsServerUpdate, [key]: true }
        : withoutKeys(s.runtimeAgentDetectionNeedsServerUpdate, (k) => k === key)
    }))
  }

  const captureOwner = (environmentId: string, expectedPairingRevision?: number) => {
    const owner = captureRuntimeAgentDetectionOwner(
      get().runtimeEnvironments,
      environmentId,
      expectedPairingRevision
    )
    const isCurrent = () => runtimeAgentDetectionOwnerIsCurrent(get().runtimeEnvironments, owner)
    return { owner, ownerKey: runtimeAgentDetectionOwnerKey(owner), isCurrent }
  }

  // Claims `key` for `owner`; a record left by a retired pairing is discarded, never shown.
  const claimRecord = (
    s: AppState,
    key: string,
    owner: RuntimeAgentDetectionOwner,
    ownerKey: string
  ): Partial<AppState> => {
    const matches = runtimeAgentDetectionCacheMatchesOwner(
      s.runtimeDetectedAgentOwnerKeys[key],
      owner
    )
    return {
      runtimeDetectedAgentIds: {
        ...s.runtimeDetectedAgentIds,
        [key]: matches ? (s.runtimeDetectedAgentIds[key] ?? null) : null
      },
      runtimeDetectedAgentOwnerKeys: { ...s.runtimeDetectedAgentOwnerKeys, [key]: ownerKey },
      runtimeAgentDetectionNeedsServerUpdate: matches
        ? s.runtimeAgentDetectionNeedsServerUpdate
        : withoutKeys(s.runtimeAgentDetectionNeedsServerUpdate, (k) => k === key)
    }
  }

  return {
    runtimeDetectedAgentIds: {},
    runtimeDetectedAgentOwnerKeys: {},
    isDetectingRuntimeAgents: {},
    isRefreshingRuntimeAgents: {},
    runtimeAgentDetectionNeedsServerUpdate: {},

    ensureRuntimeDetectedAgents: (environmentId, worktreeId, expectedPairingRevision) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      const { owner, ownerKey, isCurrent } = captureOwner(environmentId, expectedPairingRevision)
      if (!isCurrent()) {
        return Promise.resolve([])
      }
      const pendingKey = pendingDetectionKey(key, ownerKey)
      const inflightRefresh = runtimeRefreshPromises.get(pendingKey)
      if (inflightRefresh) {
        return inflightRefresh.promise
      }
      const { runtimeDetectedAgentIds, runtimeDetectedAgentOwnerKeys } = get()
      const existing = runtimeAgentDetectionCacheMatchesOwner(
        runtimeDetectedAgentOwnerKeys[key],
        owner
      )
        ? runtimeDetectedAgentIds[key]
        : null
      // Why: an empty result ([]) is truthy, so a prior "no agents found" detection
      // must not be treated as cached — re-detect so a later install / PATH fix is
      // picked up without a reconnect. Non-empty results still short-circuit.
      if (existing?.length) {
        return Promise.resolve(existing)
      }
      const inflight = runtimeDetectPromises.get(pendingKey)
      if (inflight) {
        return inflight.promise
      }

      set((s) => ({
        ...claimRecord(s, key, owner, ownerKey),
        isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: true }
      }))

      const target = { kind: 'environment', environmentId } as const
      const fence = { expectedEnvironmentPairingRevision: owner.pairingRevision }
      const isLatest = () => runtimeDetectPromises.get(pendingKey)?.promise === pending
      const pending = callRuntimeAgentDetection(environmentId, worktreeId, (params) =>
        callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectAgents', params, fence)
      )
        .then((typed) => {
          // Why: skip committing if the environment was removed (retained out)
          // or re-paired while the detect was in flight — otherwise it re-adds a
          // stale entry that retainRuntimeDetectedAgents just pruned.
          if (isCurrent() && isLatest()) {
            commitDetection(key, typed, false)
          }
          return isCurrent() ? typed : []
        })
        .catch((error: unknown): TuiAgent[] => {
          // Why: a remote runtime may be disconnected or version-incompatible.
          // Keep the menu retryable instead of pinning a failed probe forever.
          // Same in-flight guard as the .then() above.
          if (!isCurrent() || !isLatest()) {
            return []
          }
          if (error instanceof RuntimeAgentDetectionNeedsServerUpdateError) {
            commitDetection(key, [], true)
          } else {
            set((s) => ({
              isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: false }
            }))
          }
          return []
        })
        .finally(() => {
          if (isLatest()) {
            runtimeDetectPromises.delete(pendingKey)
          }
        })

      runtimeDetectPromises.set(pendingKey, { owner, promise: pending })
      return pending
    },

    refreshRuntimeDetectedAgents: (environmentId, worktreeId, expectedPairingRevision) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      const { owner, ownerKey, isCurrent } = captureOwner(environmentId, expectedPairingRevision)
      if (!isCurrent()) {
        return Promise.resolve([])
      }
      const pendingKey = pendingDetectionKey(key, ownerKey)
      const inflight = runtimeRefreshPromises.get(pendingKey)
      if (inflight) {
        return inflight.promise
      }

      // Why: a refresh is newer and authoritative; detach an older detect so its
      // late result cannot overwrite the freshly hydrated PATH result.
      runtimeDetectPromises.delete(pendingKey)
      set((s) => ({
        ...claimRecord(s, key, owner, ownerKey),
        isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [key]: true }
      }))

      const target = { kind: 'environment', environmentId } as const
      const fence = { expectedEnvironmentPairingRevision: owner.pairingRevision }
      const isLatest = () => runtimeRefreshPromises.get(pendingKey)?.promise === pending
      const pending = callRuntimeAgentDetection(environmentId, worktreeId, (params) =>
        callRuntimeRpc<{ agents: TuiAgent[] }>(target, 'preflight.refreshAgents', params, fence)
          .then((result) => result.agents)
          .catch((error) => {
            if (!isRuntimeMethodNotFoundError(error) || !isCurrent()) {
              throw error
            }
            // Why: only older servers need the fallback; retrying disconnects and
            // runtime failures doubles remote work without any chance of recovery.
            return callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectAgents', params, fence)
          })
      )
        .then((typed) => {
          // Why: same guard as ensureRuntimeDetectedAgents — if the environment
          // was retained out or re-paired mid-refresh, don't re-add a pruned entry.
          if (isCurrent() && isLatest()) {
            commitDetection(key, typed, false)
          }
          return isCurrent() ? typed : []
        })
        .catch((error: unknown) => {
          if (!isCurrent()) {
            return []
          }
          if (error instanceof RuntimeAgentDetectionNeedsServerUpdateError && isLatest()) {
            commitDetection(key, [], true)
            return []
          }
          // Why: a disconnected runtime must keep Refresh retryable and must not
          // wipe the last known agent list.
          if (isLatest()) {
            set((s) => ({
              isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: false },
              isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [key]: false }
            }))
          }
          return get().runtimeDetectedAgentIds[key] ?? []
        })
        .finally(() => {
          if (isLatest()) {
            runtimeRefreshPromises.delete(pendingKey)
          }
        })

      runtimeRefreshPromises.set(pendingKey, { owner, promise: pending })
      return pending
    },

    clearRuntimeDetectedAgents: (environmentId: string) => {
      dropEnvironments((id) => id === environmentId)
    },

    retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => {
      const keep = new Set(environmentIds)
      dropEnvironments((id) => !keep.has(id))
    }
  }
}
