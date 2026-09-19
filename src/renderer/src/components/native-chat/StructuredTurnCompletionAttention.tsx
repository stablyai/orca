/**
 * One structured tab's subscription to its own session's turn completions.
 *
 * Mounted per structured tab by the status bridge, which renders for every structured tab in
 * every workspace whether or not it is on screen — that is exactly why a backgrounded chat can
 * light anything at all. Filtering by session here rather than looking a tab up from a session id
 * keeps the addressing in one direction: the tab that owns the session is the tab that subscribes,
 * so a completion can only ever be addressed to the surface key that tab publishes.
 */
import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredTurnCompletionFeed } from '@/runtime/structured-turn-completion-feed'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { dispatchStructuredTurnCompletion } from './structured-turn-completion-attention'
import type { StructuredTab } from './structured-agent-session-tabs'

export function StructuredTurnCompletionAttention({ tab }: { tab: StructuredTab }): null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const feed = useMemo(() => getStructuredTurnCompletionFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  useEffect(() => {
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    return feed.subscribe((completion) => {
      if (completion.sessionId !== tab.entityId) {
        return
      }
      dispatchStructuredTurnCompletion(completion, {
        workspaceId: tab.worktreeId,
        paneKey,
        label: tab.label
      })
    })
  }, [feed, tab.entityId, tab.id, tab.label, tab.worktreeId])
  return null
}
