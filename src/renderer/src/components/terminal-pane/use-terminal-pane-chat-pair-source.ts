import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { ChatPairAuthority } from '@/store/slices/tabs/terminal-chat-pair-authority'
import { EMPTY_LAYOUT } from './layout-serialization'

/**
 * Where a pane reads its tab's chat owner: the store when it holds the pair (`'local'`, or
 * `'host'` with this desktop's pending click on top), otherwise the pane's own copy. On `'host'`
 * the pane's copy is only a display owner for a host chat that names no pane.
 */
export function useTerminalPaneChatPairSource(tabId: string, chatPairAuthority: ChatPairAuthority) {
  const [localChatLeafId, setChatLeafId] = useState<string | null>(
    () => useAppStore.getState().terminalLayoutsByTabId[tabId]?.chatLeafId ?? null
  )
  // Why one selector: the pending overlay rides the layout subscription instead of adding a listener.
  const { savedLayout, pendingChatPair } = useAppStore(
    useShallow((store) => ({
      savedLayout: store.terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT,
      pendingChatPair:
        chatPairAuthority === 'host' ? store.pendingChatPairByTabId[tabId] : undefined
    }))
  )
  // Why: when the store holds the pair, a pane copy could write a stale owner back.
  const storeOwnsChatPair = chatPairAuthority !== 'legacy'
  const hostChatLeafId = pendingChatPair
    ? (pendingChatPair.chatLeafId ?? null)
    : (savedLayout.chatLeafId ?? null)
  const chatLeafId =
    chatPairAuthority === 'host'
      ? (hostChatLeafId ?? localChatLeafId)
      : storeOwnsChatPair
        ? hostChatLeafId
        : localChatLeafId
  return { chatLeafId, pendingChatPair, savedLayout, setChatLeafId, storeOwnsChatPair }
}
