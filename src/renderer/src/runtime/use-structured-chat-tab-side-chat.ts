import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Tab } from '../../../shared/tab-types'
import { useAppStore } from '@/store'
import { structuredChatTabIsSideChat } from './structured-chat-tab-side-chat'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from './structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/** Read the owning host's saved relationship; a pending launch supplies it before attachment. */
export function useStructuredChatTabSideChat(
  tab: Pick<Tab, 'entityId' | 'worktreeId' | 'executionHostId' | 'sideChatOf'> | undefined
): boolean {
  const owner = useAppStore((state) => (tab ? structuredAgentSessionOwnerForTab(state, tab) : null))
  const feed = useMemo(() => {
    const target = structuredAgentSessionTargetForHost(owner)
    return target ? getStructuredAgentSessionStatusFeed(target) : null
  }, [owner])
  const sessionId = tab?.entityId
  const watched = sessionId ? feed : null
  useEffect(() => watched?.activate(), [watched])
  useSyncExternalStore(
    watched?.subscribe ?? noSubscription,
    () => (sessionId ? watched?.getSnapshot().get(sessionId)?.sideChatOf : undefined),
    () => undefined
  )
  return tab ? structuredChatTabIsSideChat(useAppStore.getState(), tab) : false
}
