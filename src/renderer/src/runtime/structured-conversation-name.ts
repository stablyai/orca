import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Tab } from '../../../shared/tab-types'
import { isAgentSessionConversationName } from '../../../shared/agent-session-conversation-name'
import { useAppStore } from '@/store'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from './structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/**
 * The owning host's saved name for one native chat, read from that host's status feed. The feed
 * keeps a closed chat's summary, so the name outlives tabs and Vault results; null while unnamed,
 * unpublished, or from a host that predates the field.
 */
export function useStructuredConversationName(
  executionHostId: string | null | undefined,
  sessionId: string | null | undefined
): string | null {
  const feed = useMemo(() => {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    return target ? getStructuredAgentSessionStatusFeed(target) : null
  }, [executionHostId])
  const watched = sessionId ? feed : null
  useEffect(() => watched?.activate(), [watched])
  return useSyncExternalStore(
    watched?.subscribe ?? noSubscription,
    () => {
      const name = sessionId ? watched?.getSnapshot().get(sessionId)?.conversationName : undefined
      // Unchecked wire data from a paired host: drop a name no record store would hold.
      return isAgentSessionConversationName(name) ? name : null
    },
    () => null
  )
}

/** The saved name for the chat an open tab shows, from the host recorded on that tab. */
export function useStructuredChatTabConversationName(
  tab: Pick<Tab, 'entityId' | 'worktreeId' | 'executionHostId'> | undefined
): string | null {
  const owner = useAppStore((state) => (tab ? structuredAgentSessionOwnerForTab(state, tab) : null))
  return useStructuredConversationName(owner, tab?.entityId)
}
