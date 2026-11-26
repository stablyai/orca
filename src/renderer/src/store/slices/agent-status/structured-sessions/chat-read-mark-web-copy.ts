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
const pendingWorkspaceIds = new Set<string>()
let receivedFullInventory = false

function clearMigrationBookkeeping(): void {
  copiedChatPaneKeys.clear()
  pendingWorkspaceIds.clear()
  receivedFullInventory = false
}

function hasLegacyMark(state: WebCopyState, sessionId: string): boolean {
  const destination = chatPaneKey(sessionId)
  const leaf = destination.slice(destination.lastIndexOf(':') + 1)
  return [state.activityClearedAtByPaneKey, state.manuallyUnreadTurnsByPaneKey].some(
    (record) =>
      record[destination] === undefined &&
      Object.keys(record).some((key) => key !== destination && key.endsWith(`:${leaf}`))
  )
}

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
  fullInventoryWorkspaceIds?: Iterable<string>
): Partial<WebCopyState> | null {
  if (state.chatReadMarksCopiedHere) {
    return null
  }
  const affectedWorkspaceIds = [...new Set(workspaceIds)]
  if (fullInventoryWorkspaceIds !== undefined) {
    receivedFullInventory = true
    const applied = new Set(affectedWorkspaceIds)
    pendingWorkspaceIds.clear()
    for (const workspaceId of fullInventoryWorkspaceIds) {
      if (!applied.has(workspaceId)) {
        pendingWorkspaceIds.add(workspaceId)
      }
    }
  } else if (receivedFullInventory) {
    for (const workspaceId of affectedWorkspaceIds) {
      pendingWorkspaceIds.delete(workspaceId)
    }
  }
  const complete = receivedFullInventory && pendingWorkspaceIds.size === 0
  const tabsByWorkspace = readTabsByWorkspace()
  const sessionIds: string[] = []
  for (const workspaceId of affectedWorkspaceIds) {
    for (const tab of tabsByWorkspace[workspaceId] ?? []) {
      if (tab.contentType !== 'agent-session' || !tab.entityId) {
        continue
      }
      const key = chatPaneKey(tab.entityId)
      if (!copiedChatPaneKeys.has(key) && hasLegacyMark(state, tab.entityId)) {
        sessionIds.push(tab.entityId)
      }
    }
  }
  if (sessionIds.length === 0) {
    if (complete) {
      clearMigrationBookkeeping()
      return { chatReadMarksCopiedHere: true }
    }
    return null
  }
  const copied = copyWebClientChatReadMarksOnce(state, () => sessionIds, complete)
  for (const sessionId of sessionIds) {
    copiedChatPaneKeys.add(chatPaneKey(sessionId))
  }
  if (complete) {
    clearMigrationBookkeeping()
  }
  return copied
}
