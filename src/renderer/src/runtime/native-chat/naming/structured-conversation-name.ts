import {
  useAppStateViewActive,
  useAppViewExternalStore,
  useAppStateValue
} from '@/store/retained-views/app-state-view'
import { useCallback, useEffect, useMemo } from 'react'
import type { Tab } from '../../../../../shared/tab-types'
import { isAgentSessionConversationName } from '../../../../../shared/agent-session/agent-session-conversation-name'
import type {
  AgentSessionNamingError,
  AgentSessionConversationName
} from '../../../../../shared/agent-session/agent-session-wire'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '../session-ownership/structured-agent-session-owner'
import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedOwner
} from '../status/structured-agent-session-status-feed'
import { agentSessionShownName } from '../../../../../shared/agent-session/agent-session-fork-name'
import {
  structuredChatForkSourceId,
  structuredChatForkSourceSavedName,
  structuredChatNameReadsSource
} from './structured-chat-shown-name'

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
  return useStructuredChatNaming(executionHostId, sessionId).name
}

export type StructuredChatNaming = Readonly<{
  /** The shown name: an older fork's appended " fork" is dropped, as its mark replaces it. */
  name: string | null
  /** The chat this one was forked from; null when it is not a fork or its host predates the mark. */
  forkSourceId: string | null
}>

/** The chat's shown name and fork mark. Reads its source only for an older fork's title, so a plain
 *  chat or new fork holds one session subscription, as the name alone did. */
export function useStructuredChatNaming(
  executionHostId: string | null | undefined,
  sessionId: string | null | undefined
): StructuredChatNaming {
  const note = useStructuredSessionSummaryField(executionHostId, sessionId, (summary) => summary)
  const sourceId = structuredChatNameReadsSource(note ?? undefined)
  const sourceSavedName = useStructuredSessionSummaryField(
    executionHostId,
    sourceId,
    (_summary, feed) => (note ? (structuredChatForkSourceSavedName(feed, note) ?? null) : null)
  )
  return useMemo(() => {
    // Unchecked wire data from a paired host: drop a name no record store would hold.
    const shown = note ? agentSessionShownName(note, sourceSavedName ?? undefined) : null
    return {
      name: isAgentSessionConversationName(shown) ? shown : null,
      forkSourceId: structuredChatForkSourceId(note ?? undefined)
    }
  }, [note, sourceSavedName])
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
  read: (
    summary: AgentSessionConversationName | undefined,
    feed: StructuredAgentSessionStatusFeedOwner
  ) => T | null | undefined
): T | null {
  const viewActive = useAppStateViewActive()
  const feed = useMemo(() => {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    return target ? getStructuredAgentSessionStatusFeed(target) : null
  }, [executionHostId])
  const watched = sessionId ? feed : null
  useEffect(() => (viewActive ? watched?.activate() : undefined), [viewActive, watched])
  const subscribe = useCallback(
    (listener: () => void) =>
      watched && sessionId ? watched.subscribeSession(sessionId, listener) : noSubscription(),
    [watched, sessionId]
  )
  return useAppViewExternalStore(
    subscribe,
    () =>
      watched && sessionId
        ? (read(watched.getNamingSnapshot().get(sessionId), watched) ?? null)
        : null,
    () => null
  )
}

/** The saved name for the chat an open tab shows, from the host recorded on that tab. */
export function useStructuredChatTabConversationName(
  tab: Pick<Tab, 'entityId' | 'worktreeId' | 'executionHostId'> | undefined
): string | null {
  return useStructuredChatTabNaming(tab).name
}

/** The open tab's shown name and fork mark, from the host recorded on that tab. */
export function useStructuredChatTabNaming(
  tab: Pick<Tab, 'entityId' | 'worktreeId' | 'executionHostId'> | undefined
): StructuredChatNaming {
  const owner = useAppStateValue((state) =>
    tab ? structuredAgentSessionOwnerForTab(state, tab) : null
  )
  return useStructuredChatNaming(owner, tab?.entityId)
}

/** The tab's chat, its owning host and its naming failure, for the tab's hover card. */
export function useStructuredChatTabNamingFailure(
  tab: Pick<Tab, 'entityId' | 'worktreeId' | 'executionHostId'> | undefined
): StructuredChatTabNamingFailure | null {
  const owner = useAppStateValue((state) =>
    tab ? structuredAgentSessionOwnerForTab(state, tab) : null
  )
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
