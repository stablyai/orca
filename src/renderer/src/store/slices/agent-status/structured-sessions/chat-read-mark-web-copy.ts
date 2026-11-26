import { copyChatReadMarksToConversationKeys } from '../../../../../../shared/agent-session/view/chat-read-mark-copy'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AppState } from '../../../types'

type WebCopyState = Pick<
  AppState,
  'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarksCopiedHere'
>

type ChatTabsByWorkspace = Readonly<
  Record<string, readonly { contentType: string; entityId?: string }[]>
>

const copiedChatPaneKeys = new Set<string>()

/** A paired web client copies its saved cutoffs and unread turns to conversation keys once; the host
 *  copies shared acknowledgements. */
export function copyWebClientChatReadMarksOnce(
  state: WebCopyState,
  sessionIds: () => Iterable<string>,
  complete = true
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
  return copied || complete
    ? { ...copied, ...(complete ? { chatReadMarksCopiedHere: true } : {}) }
    : null
}

/** Copy each chat once before a full inventory makes this device's migration complete. */
export function copyWebClientChatReadMarksForTabLists(
  state: WebCopyState,
  readTabsByWorkspace: () => ChatTabsByWorkspace,
  workspaceIds: Iterable<string>,
  complete: boolean
): Partial<WebCopyState> | null {
  if (state.chatReadMarksCopiedHere) {
    return null
  }
  const tabsByWorkspace = readTabsByWorkspace()
  const sessionIds: string[] = []
  for (const workspaceId of new Set(workspaceIds)) {
    for (const tab of tabsByWorkspace[workspaceId] ?? []) {
      if (tab.contentType !== 'agent-session' || !tab.entityId) {
        continue
      }
      const key = chatPaneKey(tab.entityId)
      if (!copiedChatPaneKeys.has(key)) {
        copiedChatPaneKeys.add(key)
        sessionIds.push(tab.entityId)
      }
    }
  }
  const copied = copyWebClientChatReadMarksOnce(state, () => sessionIds, complete)
  if (complete) {
    copiedChatPaneKeys.clear()
  }
  return copied
}
