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
 */
export function useDetectedAgents(): UseDetectedAgentsResult {
  const detectedIds = useAppStore((s) => s.detectedAgentIds)
  const isLoading = useAppStore((s) => s.isDetectingAgents)
  const isRefreshing = useAppStore((s) => s.isRefreshingAgents)
  const ensure = useAppStore((s) => s.ensureDetectedAgents)
  const refresh = useAppStore((s) => s.refreshDetectedAgents)

  useEffect(() => {
    if (detectedIds === null) {
      void ensure()
    }
  }, [detectedIds, ensure])

  return { detectedIds, isLoading, isRefreshing, refresh }
}
