import { copyChatReadMarksToConversationKeys } from '../../../../../../shared/agent-session/view/chat-read-mark-copy'
import type { AppState } from '../../../types'

/** Once per paired web client, after its host's saved UI and tabs hydrate and before any on-screen
 *  scan: its own cutoffs and unread turns gain conversation keys. The host copies the shared
 *  acknowledgements itself at profile load. */
export function copyWebClientChatReadMarksOnce(store: {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
}): void {
  const state = store.getState()
  if (state.chatReadMarksCopiedHere) {
    return
  }
  const copied = copyChatReadMarksToConversationKeys(
    {
      activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
      manuallyUnreadTurnsByPaneKey: state.manuallyUnreadTurnsByPaneKey
    },
    Object.values(state.unifiedTabsByWorktree).flat()
  )
  store.setState({ ...copied, chatReadMarksCopiedHere: true })
}
