import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  callRuntimeRpc,
  getRuntimeEnvironmentStatus,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  getRuntimeAgentInventoryEnvironmentId,
  getRuntimeAgentInventoryKey
} from './runtime-agent-inventory-key'

// Probe where the workspace runs; inventory keys distinguish host defaults from workspace-scoped results.
export type RuntimeDetectedAgentsSlice = {
  runtimeAgentInventoryOutcome: (key: string) => 'pending' | 'successful' | 'failed'
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRuntimeAgents: Record<string, boolean>
  isRefreshingRuntimeAgents: Record<string, boolean>
  /** Keys whose host is too old to list that workspace's agents; their list is empty. */
  runtimeAgentDetectionNeedsServerUpdate: Record<string, boolean>
  ensureRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null
  ) => Promise<TuiAgent[]>
  /** Refresh login-shell PATH; fall back to detectAgents only for servers predating refreshAgents. */
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null
  ) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string) => void
  /** Prune removed environments’ inventories via setRuntimeEnvironments. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

// Keep deduplicated promises outside serializable Zustand state.
const runtimeDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const latestOutcome = new Map<string, 'pending' | 'successful' | 'failed'>()
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

/** Old hosts can supply workspace agents via host defaults only on known non-Windows platforms; host-default requests remain synchronous. */
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

type PairingFence = { expectedEnvironmentPairingRevision: number | undefined }

// Why: captured before the capability wait, so a re-pair during it cannot retarget the probe.
function capturePairingFence(environmentId: string): PairingFence {
  return {
    expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(environmentId)
  }
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

export type RuntimeDetectedAgentsStoreState = RuntimeDetectedAgentsSlice &
  Parameters<typeof getConnectionIdFromState>[0]

export type RuntimeDetectedAgentsStoreSetState = (
  partial:
    | Partial<RuntimeDetectedAgentsStoreState>
    | ((state: RuntimeDetectedAgentsStoreState) => Partial<RuntimeDetectedAgentsStoreState>)
) => void

export const createRuntimeDetectedAgentsSlice: (
  set: RuntimeDetectedAgentsStoreSetState,
  get: () => RuntimeDetectedAgentsStoreState,
  store?: unknown
) => RuntimeDetectedAgentsSlice = (set, get) => {
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
    ;[...latestOutcome.keys()].filter(dropKey).forEach((key) => latestOutcome.delete(key))
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
    worktreeId: string | null | undefined,
    fence: PairingFence
  ): NestedSshAgentDetection<TuiAgent[]> | undefined => {
    const connectionId = worktreeId ? getConnectionIdFromState(get(), worktreeId) : null
    return typeof connectionId === 'string'
      ? {
          connectionId,
          call: (params) =>
            callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectRemoteAgents', params, fence)
        }
      : undefined
  }

  // Commits a settled detection; an old host commits an empty list, never its default.
  const commitDetection = (key: string, agents: TuiAgent[], needsServerUpdate: boolean): void => {
    latestOutcome.set(key, 'successful')
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
    runtimeAgentInventoryOutcome: (key) => latestOutcome.get(key) ?? 'pending',
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
      // Retry empty results so installs/PATH fixes appear without reconnect; nonempty results remain cached.
      if (existing?.length) {
        return Promise.resolve(existing)
      }
      const inflight = runtimeDetectPromises.get(key)
      if (inflight) {
        return inflight
      }

      latestOutcome.set(key, 'pending')
      set((s) => ({
        isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [key]: true }
      }))

      const target = { kind: 'environment', environmentId } as const
      const fence = capturePairingFence(environmentId)
      const pending = callRuntimeAgentDetection(
        environmentId,
        worktreeId,
        (params) => callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectAgents', params, fence),
        nestedSshDetection(target, worktreeId, fence)
      )
        .then((typed) => {
          // Removed or re-paired environments must not regain stale entries from in-flight detection.
          if (runtimeDetectPromises.get(key) === pending) {
            commitDetection(key, typed, false)
          }
          return typed
        })
        .catch((error: unknown): TuiAgent[] => {
          // Disconnected/incompatible probes stay retryable; ignore results detached by removal or re-pair.
          if (runtimeDetectPromises.get(key) !== pending) {
            return []
          }
          if (error instanceof RuntimeAgentDetectionNeedsServerUpdateError) {
            commitDetection(key, [], true)
          } else {
            latestOutcome.set(key, 'failed')
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

      // New PATH refresh supersedes older detects; their late results must not overwrite it.
      runtimeDetectPromises.delete(key)
      latestOutcome.set(key, 'pending')
      set((s) => ({
        isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [key]: true }
      }))

      const target = { kind: 'environment', environmentId } as const
      const fence = capturePairingFence(environmentId)
      const pending = callRuntimeAgentDetection(
        environmentId,
        worktreeId,
        (params) =>
          callRuntimeRpc<{ agents: TuiAgent[] }>(target, 'preflight.refreshAgents', params, fence)
            .then((result) => result.agents)
            .catch((error) => {
              if (!isRuntimeMethodNotFoundError(error)) {
                throw error
              }
              // Fallback only for old servers; repeating disconnect/runtime failures just doubles remote work.
              return callRuntimeRpc<TuiAgent[]>(target, 'preflight.detectAgents', params, fence)
            }),
        nestedSshDetection(target, worktreeId, fence)
      )
        .then((typed) => {
          // Ignore refreshes detached by environment removal or re-pair.
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
          // Disconnects keep Refresh retryable and preserve the last agent list.
          if (runtimeRefreshPromises.get(key) === pending) {
            latestOutcome.set(key, 'failed')
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
