import {
  chatTabReadMarkKey,
  copyChatReadMarksToConversationKeys
} from '../../../../../../shared/agent-session/view/chat-read-mark-copy'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../../types'

type WebCopyState = Pick<
  AppState,
  'activityClearedAtByPaneKey' | 'manuallyUnreadTurnsByPaneKey' | 'chatReadMarkKeysCopiedHere'
>

/**
 * A paired web client's own cutoffs and unread turns, for chat tabs the host just delivered: each
 * tab-keyed mark copies to its conversation key at most once, whatever order tabs arrive in, so a
 * mark the user later clears is never filled back. The host copies shared acknowledgements itself.
 */
export function copyWebClientChatReadMarks(
  state: WebCopyState,
  tabs: Iterable<Tab>
): Partial<WebCopyState> | null {
  const ledger = state.chatReadMarkKeysCopiedHere
  const fresh = new Map<string, Tab>()
  for (const tab of tabs) {
    const tabKey = chatTabReadMarkKey(tab)
    if (
      tabKey !== null &&
      ledger[tabKey] === undefined &&
      (state.activityClearedAtByPaneKey[tabKey] !== undefined ||
        state.manuallyUnreadTurnsByPaneKey[tabKey] !== undefined)
    ) {
      fresh.set(tabKey, tab)
    }
  }
  if (fresh.size === 0) {
    return null
  }
  const copied = copyChatReadMarksToConversationKeys(
    {
      activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
      manuallyUnreadTurnsByPaneKey: state.manuallyUnreadTurnsByPaneKey
    },
    fresh.values()
  )
  const at = Date.now()
  const nextLedger = { ...ledger }
  for (const tabKey of fresh.keys()) {
    nextLedger[tabKey] = at
  }
  return { ...copied, chatReadMarkKeysCopiedHere: nextLedger }
}
