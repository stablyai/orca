import { useCallback } from 'react'
import { useAppStore } from '../../store'
import { useTerminalPaneStoreActions } from './use-terminal-pane-store-actions'
import { selectUnifiedTerminalTabFields } from './terminal-unified-tab-lookup'
import type { NativeChatLeafRoute } from '../native-chat/native-chat-leaf-routing'

/**
 * Every write a pane makes to its tab's chat pair. When the store owns the pair (a local
 * worktree) each one is a single `applyTerminalChatPair`; otherwise the pane keeps its own owner.
 */
export function useTerminalPaneChatPairActions(args: {
  chatLeafId: string | null
  effectiveChatViewMode: boolean
  isChatViewMode: boolean
  setChatLeafId: (leafId: string | null) => void
  storeOwnsChatPair: boolean
  tabId: string
  unifiedTabId: string | undefined
  worktreeId: string
}) {
  const {
    chatLeafId,
    effectiveChatViewMode,
    isChatViewMode,
    setChatLeafId,
    storeOwnsChatPair,
    tabId,
    unifiedTabId,
    worktreeId
  } = args
  const { applyTerminalChatPair, setTabLayout, setTabViewMode, toggleTabViewMode } =
    useTerminalPaneStoreActions()
  const applyNativeChatLeafRoute = useCallback(
    (route: NativeChatLeafRoute): void => {
      const state = useAppStore.getState()
      const currentMode = selectUnifiedTerminalTabFields(
        state.unifiedTabsByWorktree,
        worktreeId,
        tabId
      ).isChatViewMode
      if (storeOwnsChatPair) {
        // Why compare-and-set: the route was derived from this render's pair; a newer write wins.
        const currentOwner = state.terminalLayoutsByTabId[tabId]?.chatLeafId ?? null
        if (currentMode !== isChatViewMode || currentOwner !== chatLeafId) {
          return
        }
        if (route.exitChat) {
          applyTerminalChatPair(tabId, null, 'terminal')
        } else if (isChatViewMode && route.chatLeafId && route.chatLeafId !== chatLeafId) {
          // Why: a route only claims an owner for a chat that exists; entering chat is a user action.
          applyTerminalChatPair(tabId, route.chatLeafId, 'chat')
        }
        return
      }
      if (!isChatViewMode && currentMode && chatLeafId && route.chatLeafId === null) {
        // Keep the owner through the batched toggle that turns chat mode on.
        return
      }
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      if (existingLayout && existingLayout.chatLeafId !== (route.chatLeafId ?? undefined)) {
        if (route.chatLeafId) {
          setTabLayout(tabId, { ...existingLayout, chatLeafId: route.chatLeafId })
        } else if (existingLayout?.chatLeafId) {
          const nextLayout = { ...existingLayout }
          delete nextLayout.chatLeafId
          setTabLayout(tabId, nextLayout)
        }
      }
      if (route.exitChat && unifiedTabId) {
        setTabViewMode(unifiedTabId, 'terminal')
      }
    },
    [
      applyTerminalChatPair,
      chatLeafId,
      isChatViewMode,
      setChatLeafId,
      setTabLayout,
      setTabViewMode,
      storeOwnsChatPair,
      tabId,
      unifiedTabId,
      worktreeId
    ]
  )
  const toggleNativeChatForLeaf = useCallback(
    (leafId: string) => {
      if (!unifiedTabId) {
        return
      }
      if (storeOwnsChatPair) {
        const leavesChat = effectiveChatViewMode && chatLeafId === leafId
        applyTerminalChatPair(tabId, leavesChat ? null : leafId, leavesChat ? 'terminal' : 'chat', {
          userToggle: true
        })
        return
      }
      if (effectiveChatViewMode && chatLeafId === leafId) {
        setChatLeafId(null)
        toggleTabViewMode(unifiedTabId)
        return
      }
      setChatLeafId(leafId)
      if (!effectiveChatViewMode) {
        toggleTabViewMode(unifiedTabId)
      }
    },
    [
      applyTerminalChatPair,
      chatLeafId,
      effectiveChatViewMode,
      setChatLeafId,
      storeOwnsChatPair,
      tabId,
      toggleTabViewMode,
      unifiedTabId
    ]
  )
  const switchNativeChatToTerminal = useCallback(() => {
    if (!chatLeafId || !unifiedTabId) {
      return
    }
    if (storeOwnsChatPair) {
      applyTerminalChatPair(tabId, null, 'terminal')
      return
    }
    setChatLeafId(null)
    setTabViewMode(unifiedTabId, 'terminal')
  }, [
    applyTerminalChatPair,
    chatLeafId,
    setChatLeafId,
    setTabViewMode,
    storeOwnsChatPair,
    tabId,
    unifiedTabId
  ])
  return { applyNativeChatLeafRoute, toggleNativeChatForLeaf, switchNativeChatToTerminal }
}
