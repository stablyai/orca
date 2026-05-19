import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PathSource, ShellHydrationFailureReason, TuiAgent } from '../../../../shared/types'

type LocalPreflightContext = { wslDistro?: string | null } | undefined

function getWslDistroFromPath(path?: string | null): string | null {
  if (!path) {
    return null
  }
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(?:\/|$)/i)
  return match?.[1] ?? null
}

function getLocalPreflightContext(state: AppState): LocalPreflightContext {
  const activeWorktree = state.activeWorktreeId
    ? Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === state.activeWorktreeId)
    : null
  const activePath =
    activeWorktree?.path ?? state.repos.find((repo) => repo.id === state.activeRepoId)?.path
  const wslDistro = getWslDistroFromPath(activePath)
  return wslDistro ? { wslDistro } : undefined
}

function localPreflightContextKey(context: LocalPreflightContext): string {
  return context?.wslDistro ? `wsl:${context.wslDistro}` : 'host'
}

export type DetectedAgentsSlice = {
  detectedAgentIds: TuiAgent[] | null
  isDetectingAgents: boolean
  isRefreshingAgents: boolean
  /** Telemetry classification of the most recent refreshAgents() run. `null`
   *  before the first refresh resolves. Read by the wizard at agent-pick time
   *  to attach `path_source` / `path_failure_reason` to `onboarding_agent_picked`
   *  — see docs/agent-on-path-detection.md. */
  pathSource: PathSource | null
  pathFailureReason: ShellHydrationFailureReason | null
  /** Runs `preflight.detectAgents` once per session. Subsequent callers reuse
   *  the in-flight promise so every surface sees the same result. */
  ensureDetectedAgents: () => Promise<TuiAgent[]>
  /** Re-runs `preflight.refreshAgents` (re-reads shell PATH). Concurrent callers
   *  receive the same pending promise; store fields update once on resolve so
   *  every subscribed surface re-renders in the same tick. */
  refreshDetectedAgents: () => Promise<TuiAgent[]>

  // Why: remote worktrees need per-connection agent detection. The local
  // detectedAgentIds field is connection-unaware, so remote state lives in a
  // separate map keyed by SSH connectionId.
  remoteDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRemoteAgents: Record<string, boolean>
  ensureRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  clearRemoteDetectedAgents: (connectionId: string) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
let detectPromise: { key: string; promise: Promise<TuiAgent[]> } | null = null
let refreshPromise: { key: string; promise: Promise<TuiAgent[]> } | null = null
let detectedContextKey: string | null = null
const remoteDetectPromises = new Map<string, Promise<TuiAgent[]>>()

export const createDetectedAgentsSlice: StateCreator<AppState, [], [], DetectedAgentsSlice> = (
  set,
  get
) => ({
  detectedAgentIds: null,
  isDetectingAgents: false,
  isRefreshingAgents: false,
  pathSource: null,
  pathFailureReason: null,

  ensureDetectedAgents: () => {
    const context = getLocalPreflightContext(get())
    const contextKey = localPreflightContextKey(context)
    const existing = get().detectedAgentIds
    if (existing && detectedContextKey === contextKey) {
      return Promise.resolve(existing)
    }
    if (detectPromise?.key === contextKey) {
      return detectPromise.promise
    }
    set({ isDetectingAgents: true })
    const pending = window.api.preflight
      .detectAgents(context)
      .then((ids) => {
        const typed = ids as TuiAgent[]
        set({ detectedAgentIds: typed, isDetectingAgents: false })
        detectedContextKey = contextKey
        return typed
      })
      .catch(() => {
        // Why: allow a retry on the next call if detection blew up (IPC timeout
        // during cold start). Do not cache the failure.
        detectPromise = null
        set({ isDetectingAgents: false })
        return [] as TuiAgent[]
      })
    detectPromise = { key: contextKey, promise: pending }
    return pending
  },

  refreshDetectedAgents: () => {
    const context = getLocalPreflightContext(get())
    const contextKey = localPreflightContextKey(context)
    if (refreshPromise?.key === contextKey) {
      return refreshPromise.promise
    }
    set({ isRefreshingAgents: true })
    const pending = window.api.preflight
      .refreshAgents(context)
      .then((result) => {
        const typed = result.agents as TuiAgent[]
        set({
          detectedAgentIds: typed,
          isRefreshingAgents: false,
          pathSource: result.pathSource,
          pathFailureReason: result.pathFailureReason
        })
        // Why: once refresh has run, treat its result as the current detection
        // snapshot so `ensureDetectedAgents` short-circuits.
        detectedContextKey = contextKey
        detectPromise = { key: contextKey, promise: Promise.resolve(typed) }
        return typed
      })
      .catch(() => {
        set({ isRefreshingAgents: false })
        return get().detectedAgentIds ?? []
      })
      .finally(() => {
        if (refreshPromise?.promise === pending) {
          refreshPromise = null
        }
      })
    refreshPromise = { key: contextKey, promise: pending }
    return pending
  },

  remoteDetectedAgentIds: {},
  isDetectingRemoteAgents: {},

  ensureRemoteDetectedAgents: (connectionId: string) => {
    const existing = get().remoteDetectedAgentIds[connectionId]
    if (existing) {
      return Promise.resolve(existing)
    }
    const inflight = remoteDetectPromises.get(connectionId)
    if (inflight) {
      return inflight
    }

    set((s) => ({
      isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: true }
    }))

    const pending = window.api.preflight
      .detectRemoteAgents({ connectionId })
      .then((ids) => {
        const typed = ids as TuiAgent[]
        set((s) => ({
          remoteDetectedAgentIds: { ...s.remoteDetectedAgentIds, [connectionId]: typed },
          isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
        }))
        return typed
      })
      .catch(() => {
        // Why: allow retry on next call (SSH may reconnect). Do not cache failure.
        remoteDetectPromises.delete(connectionId)
        set((s) => ({
          isDetectingRemoteAgents: { ...s.isDetectingRemoteAgents, [connectionId]: false }
        }))
        return [] as TuiAgent[]
      })

    remoteDetectPromises.set(connectionId, pending)
    return pending
  },

  // Why: the remote agent list is tied to a live SSH connection. On disconnect
  // the relay is gone, so clear both the cached result and the deduplication
  // promise. When the user reconnects and opens the quick-launch menu,
  // ensureRemoteDetectedAgents will re-detect against the new relay.
  clearRemoteDetectedAgents: (connectionId: string) => {
    remoteDetectPromises.delete(connectionId)
    set((s) => {
      const { [connectionId]: _, ...restAgents } = s.remoteDetectedAgentIds
      const { [connectionId]: __, ...restLoading } = s.isDetectingRemoteAgents
      return { remoteDetectedAgentIds: restAgents, isDetectingRemoteAgents: restLoading }
    })
  }
})
