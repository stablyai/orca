import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import {
  selectNativeChatAuxiliaryActiveChild,
  selectNativeChatAuxiliaryConversation,
  selectNativeChatAuxiliaryOpen,
  selectNativeChatAuxiliaryOpenForParent,
  type NativeChatAuxiliaryConversation,
  type NativeChatAuxiliaryParent
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'

/** The panel's conversation for its current source chat; stable while that parent holds. */
export function useNativeChatAuxiliaryConversation(
  parent: NativeChatAuxiliaryParent | null
): NativeChatAuxiliaryConversation | null {
  return useAppStore((state) =>
    parent ? (selectNativeChatAuxiliaryConversation(state, parent) ?? null) : null
  )
}

/** Parent chats read this to know the side panel currently owns the caret. */
export function useNativeChatAuxiliaryOpen(): boolean {
  return useAppStore(selectNativeChatAuxiliaryOpen)
}

export function useNativeChatAuxiliaryOpenForParent(
  parent: NativeChatAuxiliaryParent | null
): boolean {
  return useAppStore((state) =>
    parent ? selectNativeChatAuxiliaryOpenForParent(state, parent) : false
  )
}

/** Synchronous child state for the source action's disabled reason; async routing guards close. */
export function useNativeChatAuxiliaryReferenceBlockedReason(
  parent: NativeChatAuxiliaryParent | null
): string | null {
  const t = useTranslate()
  const activeChild = useAppStore((state) =>
    parent && selectNativeChatAuxiliaryOpenForParent(state, parent)
      ? selectNativeChatAuxiliaryActiveChild(state, parent)
      : null
  )
  const feed = useMemo(
    () => (activeChild ? getStructuredAgentSessionStatusFeed(activeChild.target) : null),
    [activeChild]
  )
  const sessionId = activeChild?.sessionId
  const subscribe = useCallback(
    (listener: () => void) =>
      feed && sessionId ? feed.subscribeSession(sessionId, listener) : () => undefined,
    [feed, sessionId]
  )
  const summary = useSyncExternalStore(
    subscribe,
    () => (feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined),
    () => undefined
  )
  if (summary?.sleptAt !== undefined) {
    return t(
      'components.rightSidebar.sideChat.childAsleep',
      'That side chat is asleep. Start a new one.'
    )
  }
  if (summary?.status === 'attention' || summary?.awaitsAnswer === true) {
    return t(
      'components.rightSidebar.sideChat.childWaiting',
      'Answer this side chat before adding another selection.'
    )
  }
  return null
}
