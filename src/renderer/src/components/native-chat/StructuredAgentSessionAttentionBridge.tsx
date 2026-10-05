import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
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
function StructuredAgentSessionAttention({
  tab
}: {
  tab: StructuredTab
}): React.JSX.Element | null {
  // The same owner the chat pane and status bridge read, so all of them follow one host.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  return target ? <StructuredAgentSessionOwnedAttention tab={tab} target={target} /> : null
}

function StructuredAgentSessionOwnedAttention({
  tab,
  target
}: {
  tab: StructuredTab
  target: RuntimeClientTarget
}): null {
  const feed = useMemo(() => getStructuredAgentSessionTurnCompletionFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  useEffect(
    () =>
      feed.subscribe((completion) => {
        if (completion.sessionId === tab.entityId) {
          dispatchStructuredTurnCompletionAttention(tab, completion, target)
        }
      }),
    [feed, tab, target]
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
