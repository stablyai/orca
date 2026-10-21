import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Tab } from '../../../shared/tab-types'
import { isAgentSessionConversationName } from '../../../shared/agent-session-conversation-name'
import type {
  AgentSessionNamingError,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
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
  return useStructuredSessionSummaryField(executionHostId, sessionId, (summary) => {
    const name = summary?.conversationName
    // Unchecked wire data from a paired host: drop a name no record store would hold.
    return isAgentSessionConversationName(name) ? name : null
  })
}

const NAMING_ERROR_MESSAGE_LIMIT = 1024

/** Why the owning host could not name this chat, while it still applies; null otherwise. */
export function useStructuredConversationNamingError(
  executionHostId: string | null | undefined,
  sessionId: string | null | undefined
): AgentSessionNamingError | null {
  return useStructuredSessionSummaryField(executionHostId, sessionId, (summary) => {
    const error = summary?.namingError
    // Unchecked wire data: keep the published object itself so the snapshot stays stable.
    return typeof error?.message === 'string' &&
      error.message.length > 0 &&
      error.message.length <= NAMING_ERROR_MESSAGE_LIMIT &&
      typeof error.failedAt === 'number'
      ? error
      : null
  })
}

function useStructuredSessionSummaryField<T>(
  executionHostId: string | null | undefined,
  sessionId: string | null | undefined,
  read: (summary: AgentSessionStatusSummary | undefined) => T | null
): T | null {
  const feed = useMemo(() => {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    return target ? getStructuredAgentSessionStatusFeed(target) : null
  }, [executionHostId])
  const watched = sessionId ? feed : null
  useEffect(() => watched?.activate(), [watched])
  return useSyncExternalStore(
    watched?.subscribe ?? noSubscription,
    () => read(sessionId ? watched?.getSnapshot().get(sessionId) : undefined),
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

/** The tab's chat, its owning host and its naming failure, for the tab's hover card. */
export function useStructuredChatTabNamingFailure(
  tab: Pick<Tab, 'entityId' | 'worktreeId' | 'executionHostId'> | undefined
): StructuredChatTabNamingFailure | null {
  const owner = useAppStore((state) => (tab ? structuredAgentSessionOwnerForTab(state, tab) : null))
  const error = useStructuredConversationNamingError(owner, tab?.entityId)
  const sessionId = tab?.entityId
  return useMemo(
    () => (error && sessionId ? { sessionId, executionHostId: owner, error } : null),
    [error, owner, sessionId]
  )
}

export type StructuredChatTabNamingFailure = {
  sessionId: string
  executionHostId: string | null
  error: AgentSessionNamingError
}
