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

type FullInventory = {
  affirmedWorkspaceIds: Iterable<string>
  pendingWorkspaceIds: Iterable<string>
}

const copiedChatPaneKeys = new Set<string>()
const pendingWorkspaceIds = new Set<string>()
let receivedFullInventory = false
const paneKeysByLeafByRecord = new WeakMap<object, Map<string, string[]>>()

function clearMigrationBookkeeping(): void {
  copiedChatPaneKeys.clear()
  pendingWorkspaceIds.clear()
  receivedFullInventory = false
}

function hasLegacyMark(state: WebCopyState, sessionId: string): boolean {
  const key = chatPaneKey(sessionId)
  const leaf = key.slice(key.lastIndexOf(':') + 1)
  return [state.activityClearedAtByPaneKey, state.manuallyUnreadTurnsByPaneKey].some(
    (record) =>
      paneKeysByLeaf(record)
        .get(leaf)
        ?.some((paneKey) => paneKey !== key) === true
  )
}

function paneKeysByLeaf(record: Readonly<Record<string, number>>): Map<string, string[]> {
  const cached = paneKeysByLeafByRecord.get(record)
  if (cached) {
    return cached
  }
  const byLeaf = new Map<string, string[]>()
  for (const key of Object.keys(record)) {
    const leaf = key.slice(key.lastIndexOf(':') + 1)
    const keys = byLeaf.get(leaf)
    if (keys) {
      keys.push(key)
    } else {
      byLeaf.set(leaf, [key])
    }
  }
  paneKeysByLeafByRecord.set(record, byLeaf)
  return byLeaf
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
  readTabsByWorkspace: (() => ChatTabsByWorkspace) | undefined,
  workspaceIds: Iterable<string>,
  fullInventory?: FullInventory
): Partial<WebCopyState> | null {
  if (state.chatReadMarksCopiedHere) {
    return null
  }
  const affectedWorkspaceIds = [...new Set(fullInventory?.affirmedWorkspaceIds ?? workspaceIds)]
  if (fullInventory) {
    receivedFullInventory = true
    pendingWorkspaceIds.clear()
    for (const workspaceId of fullInventory.pendingWorkspaceIds) {
      pendingWorkspaceIds.add(workspaceId)
    }
  } else if (receivedFullInventory) {
    for (const workspaceId of affectedWorkspaceIds) {
      pendingWorkspaceIds.delete(workspaceId)
    }
  }
  const complete = receivedFullInventory && pendingWorkspaceIds.size === 0
  if (!readTabsByWorkspace) {
    if (complete) {
      clearMigrationBookkeeping()
      return { chatReadMarksCopiedHere: true }
    }
    return null
  }
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
