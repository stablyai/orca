import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/structured-agent-session-turn-completion-feed'
import { dispatchStructuredTurnCompletionAttention } from './structured-attention-dispatch'
import { getStructuredAgentSessionTabs, type StructuredTab } from './structured-agent-session-tabs'

/**
 * One subscription per open structured tab, so a finished chat lights its unread indicators
 * whether or not its transcript is on screen.
 *
 * Subscribing per tab rather than once per host is what makes this correct, not just convenient:
 * the tab IS the attention surface. A completion for a session with no open tab has no surface to
 * mark and no liveness evidence in this process, and the surface adapter would reject it anyway.
 */
function StructuredAgentSessionAttention({ tab }: { tab: StructuredTab }): null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const feed = useMemo(() => getStructuredAgentSessionTurnCompletionFeed(target), [target])
  const statusFeed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  useEffect(
    () =>
      feed.subscribe((completion) => {
        if (completion.sessionId === tab.entityId) {
          // The status mirror, not the row: the host publishes the status before the completion,
          // and the row is only projected from the mirror after a render.
          const hostStatus = statusFeed.getSnapshot().get(tab.entityId)?.status
          dispatchStructuredTurnCompletionAttention(tab, completion, hostStatus)
        }
      }),
    [feed, statusFeed, tab]
  )
  return null
}

export function StructuredAgentSessionAttentionBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) => getStructuredAgentSessionTabs(state.unifiedTabsByWorktree))
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionAttention key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
