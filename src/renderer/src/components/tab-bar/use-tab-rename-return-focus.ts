import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { useAppStore } from '@/store'

export function useTabRenameReturnFocus({
  commitRename,
  cancelRename,
  tabId,
  unifiedTabId,
  worktreeId,
  groupId,
  isNativeChat
}: {
  commitRename: () => void
  cancelRename: () => void
  tabId: string
  unifiedTabId: string
  worktreeId: string
  groupId: string
  isNativeChat: boolean
}) {
  const renameOwnerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    return () => {
      generationRef.current += 1
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  const restoreContentFocus = useCallback(() => {
    const owner = renameOwnerRef.current
    if (!owner) {
      return
    }
    const leafId = useAppStore.getState().terminalLayoutsByTabId[tabId]?.activeLeafId
    const generation = ++generationRef.current
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
    }
    const canRestoreFocus = (): boolean => {
      const state = useAppStore.getState()
      const active = document.activeElement
      return Boolean(
        generationRef.current === generation &&
        owner.isConnected &&
        owner === renameOwnerRef.current &&
        owner.getClientRects().length > 0 &&
        getComputedStyle(owner).visibility === 'visible' &&
        !owner.closest('[aria-hidden="true"], [inert]') &&
        state.activeGroupIdByWorktree[worktreeId] === groupId &&
        state.groupsByWorktree[worktreeId]?.some(
          (group) => group.id === groupId && group.activeTabId === unifiedTabId
        ) &&
        (isNativeChat || state.terminalLayoutsByTabId[tabId]?.activeLeafId === leafId) &&
        (active === null || active === document.body) &&
        !document.querySelector('[data-tab-rename-input="true"]') &&
        !hasVisibleOverlay({ ignoreContaining: owner, ignoreDismissed: true })
      )
    }
    // Wait for the focused rename input to unmount before checking who owns focus.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (!canRestoreFocus()) {
        return
      }
      if (isNativeChat) {
        requestNativeChatComposerFocus(tabId, { onlyIfFocusUnclaimed: true })
      } else if (leafId) {
        focusTerminalTabSurface(tabId, leafId, {
          onlyIfFocusUnclaimed: true,
          oneShotChatComposerFocus: true,
          shouldFocus: canRestoreFocus
        })
      }
    })
  }, [groupId, isNativeChat, tabId, unifiedTabId, worktreeId])

  const onRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (isImeCompositionKeyDown(event)) {
        return
      }
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        if (event.key === 'Enter') {
          commitRename()
        } else {
          cancelRename()
        }
        restoreContentFocus()
      }
    },
    [cancelRename, commitRename, restoreContentFocus]
  )

  return { renameOwnerRef, onRenameKeyDown }
}
