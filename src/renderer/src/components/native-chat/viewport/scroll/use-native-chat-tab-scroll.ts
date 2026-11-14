import { useEffect } from 'react'
import { onSessionTabScroll } from '@/lib/workspace/tabs/session-tab-scroll-event'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { NativeChatMessageListHandle } from '../../messages/actions/use-native-chat-reveal-latest'

/** The tab a transcript shows; `paneKey` is the terminal pane a terminal-backed chat stands in for. */
export type NativeChatTabScrollTarget = {
  tabId: string
  paneKey: string | null
  isVisible: boolean
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
}

/**
 * Answers outside scroll requests (e.g. a hardware dial) for this tab's transcript while it is on screen.
 * A request naming another leaf of a split tab belongs to that pane, not to this transcript.
 */
export function useNativeChatTabScroll(target: NativeChatTabScrollTarget | null): void {
  const tabId = target?.tabId ?? null
  const isVisible = target?.isVisible === true
  const messageListRef = target?.messageListRef ?? null
  const leafId = target?.paneKey ? (parsePaneKey(target.paneKey)?.leafId ?? null) : null
  useEffect(() => {
    if (!tabId || !isVisible || !messageListRef) {
      return
    }
    return onSessionTabScroll(tabId, (detail) =>
      detail.leafId === null || detail.leafId === leafId
        ? (messageListRef.current?.scrollBy(detail.deltaY) ?? false)
        : false
    )
  }, [tabId, leafId, isVisible, messageListRef])
}
