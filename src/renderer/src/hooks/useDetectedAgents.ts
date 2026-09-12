import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'

export type UseDetectedAgentsResult = {
  /** Null while detection is in flight on first load. */
  detectedIds: TuiAgent[] | null
  isLoading: boolean
  /** True when the first probe for this mounted remote target finished without a result. */
  detectionFailed: boolean
  isRefreshing: boolean
  /** Forces a re-detect on the target host (`preflight.refreshAgents` for
   *  local/runtime targets, a fresh probe for SSH) and updates every
   *  subscribed surface in the same tick. Idempotent while in flight:
   *  concurrent callers receive the same pending promise. */
  refresh: () => Promise<TuiAgent[]>
}

export type AgentDetectionTarget =
  | { kind: 'local'; worktreeId?: string | null; contextKey?: string }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string }

function normalizeAgentDetectionTarget(
  target: AgentDetectionTarget | string | null | undefined
): AgentDetectionTarget | undefined {
  if (target === undefined) {
    return undefined
  }
  if (target === null) {
    return { kind: 'local' }
  }
  if (typeof target === 'string') {
    return { kind: 'ssh', connectionId: target }
  }
  return target
}

/**
 * Single source of truth for detected agent IDs across the renderer.
 *
 * Why: previously AgentsPane, NewWorkspaceComposerCard, and
 * `detect-agents-cached.ts` each ran their own detection. A tab-bar button
 * that doesn't refresh when Settings → Agents refreshes would feel broken;
 * centralizing the state eliminates multi-owner drift.
 *
 * @param connectionId — Pass a string for legacy SSH callers, or an
 * AgentDetectionTarget for local/SSH/runtime hosts. Pass null for local
 * detection. Pass undefined when the connection context is not yet known
 * (store not hydrated) — returns loading state.
 */
export function useDetectedAgents(
  connectionId: AgentDetectionTarget | string | null | undefined
): UseDetectedAgentsResult {
  const target = normalizeAgentDetectionTarget(connectionId)
  const observedRemoteTargetKeysRef = useRef<Set<string>>(new Set())
  // Why: undefined means "store not yet hydrated" — we don't know if the
  // worktree is local or remote yet. This prevents flashing local agents for
  // remote worktrees during hydration.
  const isUnknown = target === undefined
  const targetKind = target?.kind
  const targetId =
    target?.kind === 'ssh'
      ? target.connectionId
      : target?.kind === 'runtime'
        ? target.environmentId
        : null
  const localWorktreeId = target?.kind === 'local' ? target.worktreeId : undefined
  const localContextKey = target?.kind === 'local' ? target.contextKey : undefined
  const remoteTargetKey =
    targetKind === 'ssh' && targetId
      ? `ssh:${targetId}`
      : targetKind === 'runtime' && targetId
        ? `runtime:${targetId}`
        : null

  const detectedIds = useAppStore((s) => {
    if (isUnknown) {
      return null
    }
    if (targetKind === 'ssh' && targetId) {
      return s.remoteDetectedAgentIds[targetId] ?? null
    }
    if (targetKind === 'runtime' && targetId) {
      return s.runtimeDetectedAgentIds[targetId] ?? null
    }
    return localContextKey
      ? (s.localDetectedAgentIdsByContext[localContextKey] ?? null)
      : s.detectedAgentIds
  })
  const isLoading = useAppStore((s) => {
    if (isUnknown) {
      return true
    }
    if (targetKind === 'ssh' && targetId) {
      return s.isDetectingRemoteAgents[targetId] ?? false
    }
    if (targetKind === 'runtime' && targetId) {
      return s.isDetectingRuntimeAgents[targetId] ?? false
    }
    return localContextKey
      ? (s.isDetectingLocalAgentsByContext[localContextKey] ?? false)
      : s.isDetectingAgents
  })
  const isRefreshing = useAppStore((s) => {
    if (targetKind === 'runtime' && targetId) {
      return s.isRefreshingRuntimeAgents[targetId] ?? false
    }
    if (targetKind === 'ssh' && targetId) {
      return s.isDetectingRemoteAgents[targetId] ?? false
    }
    if (targetKind !== 'local') {
      return false
    }
    return localContextKey
      ? (s.isRefreshingLocalAgentsByContext[localContextKey] ?? false)
      : s.isRefreshingAgents
  })
  const detectionFailed =
    detectedIds === null &&
    !isLoading &&
    !isRefreshing &&
    remoteTargetKey !== null &&
    observedRemoteTargetKeysRef.current.has(remoteTargetKey)
  // Why: refresh must hit the same host the list came from — refreshing the
  // local PATH while showing a remote server's agents is a silent no-op.
  const refresh = useCallback((): Promise<TuiAgent[]> => {
    if (isUnknown) {
      return Promise.resolve([])
    }
    // Why: retained tab bars stay mounted; imperative action reads avoid six
    // no-op Zustand subscriptions per hook during unrelated store churn.
    const state = useAppStore.getState()
    if (targetKind === 'runtime' && targetId) {
      return state.refreshRuntimeDetectedAgents(targetId)
    }
    if (targetKind === 'ssh' && targetId) {
      return state.refreshRemoteDetectedAgents(targetId)
    }
    return state.refreshDetectedAgents(localWorktreeId)
  }, [isUnknown, localWorktreeId, targetKind, targetId])

  useEffect(() => {
    if (isUnknown) {
      return
    }
    const isNewRemoteTarget =
      remoteTargetKey !== null && !observedRemoteTargetKeysRef.current.has(remoteTargetKey)
    // Why: switching A → B → A is still one mounted surface; remember every
    // target so each one keeps its once-per-surface probe without respawning
    // detection on every switch back.
    if (remoteTargetKey !== null) {
      observedRemoteTargetKeysRef.current.add(remoteTargetKey)
    }
    const state = useAppStore.getState()
    if (targetKind === 'ssh' && targetId) {
      if (detectedIds === null) {
        void state.ensureRemoteDetectedAgents(targetId)
      } else if (isNewRemoteTarget) {
        // Why: a newly opened remote launch surface must re-probe even when it
        // already has a cached list — otherwise a CLI installed after the last
        // probe stays invisible until the renderer restarts. Once per surface,
        // per target, so this cannot spin.
        void state.ensureRemoteDetectedAgents(targetId, { force: true })
      }
    } else if (targetKind === 'runtime' && targetId) {
      if (detectedIds === null) {
        void state.ensureRuntimeDetectedAgents(targetId)
      } else if (isNewRemoteTarget) {
        // Why: remote `orca serve` users can install/fix PATH without
        // reconnecting; retry once per mounted surface so the menu can pick
        // that up regardless of what the previous probe found.
        void state.ensureRuntimeDetectedAgents(targetId, { force: true })
      }
    } else {
      if (detectedIds === null) {
        void state.ensureDetectedAgents(localWorktreeId)
      }
    }
  }, [
    isUnknown,
    targetKind,
    targetId,
    remoteTargetKey,
    detectedIds,
    localWorktreeId,
    localContextKey
  ])

  return { detectedIds, isLoading, detectionFailed, isRefreshing, refresh }
}
