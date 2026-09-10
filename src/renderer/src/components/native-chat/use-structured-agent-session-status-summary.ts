import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

/** The host's projected status for one session, live while the caller is mounted. */
export function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget
): AgentSessionStatusSummary | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId) ?? null,
    () => null
  )
}
