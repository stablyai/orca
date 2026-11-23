import { copyChatReadMarksToConversationKeys } from '../../../../../../shared/agent-session/view/chat-read-mark-copy'
import type { AppState } from '../../../types'

type WebCopyState = Pick<
  AppState,
  'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarksCopiedHere'
>

/** Once per paired web client, from the host's first tab list: its own saved cutoffs and unread
 *  turns gain conversation keys (chat-read-mark-copy.ts). The host copies shared acknowledgements. */
export function copyWebClientChatReadMarksOnce(
  state: WebCopyState,
  sessionIds: Iterable<string>
): Partial<WebCopyState> | null {
  if (state.chatReadMarksCopiedHere) {
    return null
  }
  const copied = copyChatReadMarksToConversationKeys(
    {
      activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
      manuallyUnreadTurnsByPaneKey: state.manuallyUnreadTurnsByPaneKey
    },
    sessionIds
  )
  return { ...copied, chatReadMarksCopiedHere: true }
}
