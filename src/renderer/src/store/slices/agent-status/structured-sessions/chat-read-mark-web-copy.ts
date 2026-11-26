import { copyChatReadMarksToConversationKeys } from '../../../../../../shared/agent-session/view/chat-read-mark-copy'
import type { AppState } from '../../../types'

type WebCopyState = Pick<
  AppState,
  'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarksCopiedHere'
>

type ChatTabsSnapshot = { tabs: readonly { type: string; sessionId?: string }[] }

/** Once per paired web client, from the host's first tab list: its own saved cutoffs and unread
 *  turns gain conversation keys (chat-read-mark-copy.ts). The host copies shared acknowledgements. */
export function copyWebClientChatReadMarksOnce(
  state: WebCopyState,
  sessionIds: () => Iterable<string>
): Partial<WebCopyState> | null {
  if (state.chatReadMarksCopiedHere) {
    return null
  }
  const copied = copyChatReadMarksToConversationKeys(
    {
      activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
      manuallyUnreadTurnsByPaneKey: state.manuallyUnreadTurnsByPaneKey
    },
    sessionIds()
  )
  return { ...copied, chatReadMarksCopiedHere: true }
}

/** Copy before the first snapshot that introduces chats can run attention cleanup. */
export function copyWebClientChatReadMarksFromSnapshotsOnce(
  state: WebCopyState,
  snapshots: readonly ChatTabsSnapshot[]
): Partial<WebCopyState> | null {
  const sessionIds = snapshots.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session' && typeof tab.sessionId === 'string' ? [tab.sessionId] : []
    )
  )
  return sessionIds.length === 0 ? null : copyWebClientChatReadMarksOnce(state, () => sessionIds)
}
