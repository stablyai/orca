import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  callRuntimeRpc,
  getRuntimeEnvironmentStatus,
  RuntimeRpcCallError,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  getRuntimeAgentInventoryEnvironmentId,
  getRuntimeAgentInventoryKey
} from './runtime-agent-inventory-key'

// Why: remote runtime hosts are not SSH connections, but their launch surfaces
// (tab bar, quick launch, Settings → Agents under an Active Server) still have
// to probe the host where the workspace actually runs.
// Records are keyed by getRuntimeAgentInventoryKey: the environment alone for
// the host-default list, or environment + workspace for a workspace's list.
export type RuntimeDetectedAgentsSlice = {
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRuntimeAgents: Record<string, boolean>
  isRefreshingRuntimeAgents: Record<string, boolean>
  /** Keys whose host is too old to list that workspace's agents; their list is empty. */
  runtimeAgentDetectionNeedsServerUpdate: Record<string, boolean>
  ensureRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null
  ) => Promise<TuiAgent[]>
  /** Forces a re-detect on the runtime host via `preflight.refreshAgents`
   *  (login-shell PATH re-read), falling back to `preflight.detectAgents` for
   *  servers that predate the refresh RPC. */
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null
  ) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
  /** Drops runtime detected-agent caches for environments not in the kept set.
   *  Wired into setRuntimeEnvironments so removed environments don't leak their
   *  detected-agent entries for the renderer session. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
const runtimeDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const runtimeRefreshPromises = new Map<string, Promise<TuiAgent[]>>()

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export class RuntimeAgentDetectionNeedsServerUpdateError extends Error {
  constructor() {
    super("Update Orca on this server to list this workspace's agents.")
    this.name = 'RuntimeAgentDetectionNeedsServerUpdateError'
  }
}

/** A paired host's workspace that lives on one of that host's own SSH targets. */
type NestedSshAgentDetection<T> = {
  connectionId: string
  call: (params: { connectionId: string }) => Promise<T>
}

/**
 * Sends `preflight.detectAgents` / `refreshAgents` scoped to a workspace. A host without the
 * workspace-scoped capability can only answer its own default, which is the workspace's list only
 * on a known non-Windows host. The host default goes out synchronously, as it always has.
 */
export function callRuntimeAgentDetection<T>(
  environmentId: string,
  worktreeId: string | null | undefined,
  call: (params: { worktreeId: string } | undefined) => Promise<T>,
  nestedSsh?: NestedSshAgentDetection<T>
): Promise<T> {
  if (!worktreeId) {
    return call(undefined)
  }
  const capability = PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY
  return runtimeEnvironmentSupportsCapability(environmentId, capability).then(async (supported) => {
    if (supported) {
      return call({ worktreeId })
    }
    // Why: a fresh status both reports the platform and catches an in-place upgrade.
    const status = await getRuntimeEnvironmentStatus(environmentId)
    if (status.capabilities?.includes(capability)) {
      return call({ worktreeId })
    }
    // Why: the host's SSH workspace runs on its SSH target, which old hosts already probe by id.
    if (nestedSsh) {
      return nestedSsh.call({ connectionId: nestedSsh.connectionId })
    }
    // Why: an old Windows host's default omits a WSL workspace's agents; an absent platform may be one.
    if (!status.hostPlatform || status.hostPlatform === 'win32') {
      throw new RuntimeAgentDetectionNeedsServerUpdateError()
    }
    return call(undefined)
  })
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
      for (const key of promises.keys()) {
        if (dropKey(key)) {
          promises.delete(key)
        }
      }
    }
    set((s) => {
      const runtimeDetectedAgentIds = withoutKeys(s.runtimeDetectedAgentIds, dropKey)
      const isDetectingRuntimeAgents = withoutKeys(s.isDetectingRuntimeAgents, dropKey)
      const isRefreshingRuntimeAgents = withoutKeys(s.isRefreshingRuntimeAgents, dropKey)
      const runtimeAgentDetectionNeedsServerUpdate = withoutKeys(
        s.runtimeAgentDetectionNeedsServerUpdate,
        dropKey
      )
      return runtimeDetectedAgentIds === s.runtimeDetectedAgentIds &&
        isDetectingRuntimeAgents === s.isDetectingRuntimeAgents &&
        isRefreshingRuntimeAgents === s.isRefreshingRuntimeAgents &&
        runtimeAgentDetectionNeedsServerUpdate === s.runtimeAgentDetectionNeedsServerUpdate
        ? s
        : {
            runtimeDetectedAgentIds,
            isDetectingRuntimeAgents,
            isRefreshingRuntimeAgents,
            runtimeAgentDetectionNeedsServerUpdate
          }
    })
  }

  const nestedSshDetection = (
    target: RuntimeClientTarget,
    worktreeId: string | null | undefined
  ): NestedSshAgentDetection<TuiAgent[]> | undefined => {
    const connectionId = worktreeId ? getConnectionIdFromState(get(), worktreeId) : null
    return typeof connectionId === 'string'
      ? {
          connectionId,
          call: (params) =>
            callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectRemoteAgents', params)
        }
      : undefined
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

  return {
    runtimeDetectedAgentIds: {},
    isDetectingRuntimeAgents: {},
    isRefreshingRuntimeAgents: {},
    runtimeAgentDetectionNeedsServerUpdate: {},

    ensureRuntimeDetectedAgents: (environmentId: string, worktreeId?: string | null) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      const inflightRefresh = runtimeRefreshPromises.get(key)
      if (inflightRefresh) {
        return inflightRefresh
      }
      const existing = get().runtimeDetectedAgentIds[key]
      // Why: an empty result ([]) is truthy, so a prior "no agents found" detection
      // must not be treated as cached — re-detect so a later install / PATH fix is
      // picked up without a reconnect. Non-empty results still short-circuit.
      if (existing?.length) {
        return Promise.resolve(existing)
      }
      const inflight = runtimeDetectPromises.get(key)
      if (inflight) {
        return inflight
      }

      set((s) => ({
        isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: true }
      }))

      const target = { kind: 'environment', environmentId } as const
      const pending = callRuntimeAgentDetection(
        environmentId,
        worktreeId,
        (params) => callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectAgents', params),
        nestedSshDetection(target, worktreeId)
      )
        .then((typed) => {
          // Why: skip committing if the environment was removed (retained out)
          // while the detect was in flight — otherwise it re-adds a stale entry
          // that retainRuntimeDetectedAgents just pruned.
          if (runtimeDetectPromises.get(key) === pending) {
            commitDetection(key, typed, false)
          }
          return typed
        })
        .catch((error: unknown): TuiAgent[] => {
          // Why: a remote runtime may be disconnected or version-incompatible.
          // Keep the menu retryable instead of pinning a failed probe forever.
          // Same in-flight guard as the .then() above.
          if (runtimeDetectPromises.get(key) !== pending) {
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
          if (runtimeDetectPromises.get(key) === pending) {
            runtimeDetectPromises.delete(key)
          }
        })

      runtimeDetectPromises.set(key, pending)
      return pending
    },

    refreshRuntimeDetectedAgents: (environmentId: string, worktreeId?: string | null) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      const inflight = runtimeRefreshPromises.get(key)
      if (inflight) {
        return inflight
      }

      // Why: a refresh is newer and authoritative; detach an older detect so its
      // late result cannot overwrite the freshly hydrated PATH result.
      runtimeDetectPromises.delete(key)
      set((s) => ({
        isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [key]: true }
      }))

      const target = { kind: 'environment', environmentId } as const
      const pending = callRuntimeAgentDetection(
        environmentId,
        worktreeId,
        (params) =>
          callRuntimeRpc<{ agents: TuiAgent[] }>(target, 'preflight.refreshAgents', params)
            .then((result) => result.agents)
            .catch((error) => {
              if (!isRuntimeMethodNotFoundError(error)) {
                throw error
              }
              // Why: only older servers need the fallback; retrying disconnects and
              // runtime failures doubles remote work without any chance of recovery.
              return callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectAgents', params)
            }),
        nestedSshDetection(target, worktreeId)
      )
        .then((typed) => {
          // Why: same guard as ensureRuntimeDetectedAgents — if the environment
          // was retained out mid-refresh, don't re-add a pruned entry.
          if (runtimeRefreshPromises.get(key) === pending) {
            commitDetection(key, typed, false)
          }
          return typed
        })
        .catch((error: unknown) => {
          if (
            error instanceof RuntimeAgentDetectionNeedsServerUpdateError &&
            runtimeRefreshPromises.get(key) === pending
          ) {
            commitDetection(key, [], true)
            return []
          }
          // Why: a disconnected runtime must keep Refresh retryable and must not
          // wipe the last known agent list.
          if (runtimeRefreshPromises.get(key) === pending) {
            set((s) => ({
              isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: false },
              isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [key]: false }
            }))
          }
          return get().runtimeDetectedAgentIds[key] ?? []
        })
        .finally(() => {
          if (runtimeRefreshPromises.get(key) === pending) {
            runtimeRefreshPromises.delete(key)
          }
        })

      runtimeRefreshPromises.set(key, pending)
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
