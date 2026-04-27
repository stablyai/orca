import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/types'

export type UseDetectedAgentsResult = {
  /** Null while detection is in flight on first load. */
  detectedIds: TuiAgent[] | null
  isLoading: boolean
  isRefreshing: boolean
  /** Re-runs `preflight.refreshAgents` and updates every subscribed surface in
   *  the same tick. Idempotent while in flight: concurrent callers receive the
   *  same pending promise. */
  refresh: () => Promise<TuiAgent[]>
}

/**
 * Single source of truth for detected agent IDs across the renderer.
 *
 * Why: previously AgentsPane, NewWorkspaceComposerCard, and
 * `detect-agents-cached.ts` each ran their own detection. A tab-bar button
 * that doesn't refresh when Settings → Agents refreshes would feel broken;
 * centralizing the state eliminates multi-owner drift.
 *
 * @param connectionId — Pass a string to detect agents on a remote SSH host.
 * Pass null for local detection. Pass undefined (or omit) when the connection
 * context is not yet known (store not hydrated) — returns loading state.
 * Backward-compatible: all existing callers pass no argument.
 */
export function useDetectedAgents(
  connectionId: string | null | undefined = null
): UseDetectedAgentsResult {
  // Why: undefined means "store not yet hydrated" — we don't know if the
  // worktree is local or remote yet. null means confirmed-local. string means
  // confirmed-remote. This three-way distinction prevents flashing local agents
  // for remote worktrees during hydration.
  const isRemote = typeof connectionId === 'string'
  const isUnknown = connectionId === undefined

  const detectedIds = useAppStore((s) => {
    if (isUnknown) {
      return null
    }
    if (isRemote) {
      return s.remoteDetectedAgentIds[connectionId] ?? null
    }
    return s.detectedAgentIds
  })
  const isLoading = useAppStore((s) => {
    if (isUnknown) {
      return true
    }
    if (isRemote) {
      return s.isDetectingRemoteAgents[connectionId] ?? false
    }
    return s.isDetectingAgents
  })
  const isRefreshing = useAppStore((s) => (isRemote || isUnknown ? false : s.isRefreshingAgents))
  const ensureLocal = useAppStore((s) => s.ensureDetectedAgents)
  const ensureRemote = useAppStore((s) => s.ensureRemoteDetectedAgents)
  const refresh = useAppStore((s) => s.refreshDetectedAgents)

  useEffect(() => {
    if (isUnknown) {
      return
    }
    if (isRemote) {
      if (detectedIds === null) {
        void ensureRemote(connectionId)
      }
    } else {
      if (detectedIds === null) {
        void ensureLocal()
      }
    }
  }, [isRemote, isUnknown, connectionId, detectedIds, ensureLocal, ensureRemote])

  return { detectedIds, isLoading, isRefreshing, refresh }
}
