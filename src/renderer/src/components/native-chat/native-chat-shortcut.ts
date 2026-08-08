import { useEffect } from 'react'
import type { TerminalPaneTitleController } from '../terminal-pane/use-terminal-pane-title-state'
import type { AppState } from '@/store/types'
/** Platform-correct binding for the native-chat view toggle.
 *
 *  Key: Cmd/Ctrl + Shift + J. The primary modifier follows AGENTS.md — metaKey
 *  on Mac, ctrlKey elsewhere — and the displayed label uses `⌘`/`⇧` on Mac and
 *  `Ctrl+`/`Shift+` on Linux/Windows.
 */

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

/** Human-readable label for the toggle shortcut, platform-correct. */
export function nativeChatToggleShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘⇧J' : 'Ctrl+Shift+J'
}

/** True when the event is the native-chat toggle chord for the given platform.
 *  Pure so it can be unit-tested without a DOM. */
export function matchesNativeChatToggleShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean {
  if (e.altKey || !e.shiftKey) {
    return false
  }
  // Primary modifier is Cmd on Mac, Ctrl on Linux/Windows — and must be the
  // *only* primary modifier so this can't collide with Cmd+Ctrl chords.
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) {
    return false
  }
  return e.key.toLowerCase() === 'j'
}

export const NATIVE_CHAT_TOGGLE_REQUEST_EVENT = 'orca-native-chat-toggle-request'

export function requestNativeChatToggle(terminalTabId: string): void {
  window.dispatchEvent(
    new CustomEvent<{ terminalTabId: string }>(NATIVE_CHAT_TOGGLE_REQUEST_EVENT, {
      detail: { terminalTabId }
    })
  )
}

export function useNativeChatToggleRequest({
  chatLeafId,
  effectiveChatViewMode,
  managerRef,
  setChatLeafId,
  setTabViewMode,
  tabId,
  unifiedTabId
}: Pick<TerminalPaneTitleController, 'chatLeafId' | 'managerRef' | 'setChatLeafId' | 'tabId'> & {
  effectiveChatViewMode: boolean
  unifiedTabId: string | null | undefined
  setTabViewMode: AppState['setTabViewMode']
}): void {
  useEffect(() => {
    const handleRequest = (event: Event): void => {
      const request = event as CustomEvent<{ terminalTabId?: string }>
      if (request.detail?.terminalTabId !== tabId || !unifiedTabId) {
        return
      }
      const activeLeafId = managerRef.current?.getActivePane()?.leafId
      if (!activeLeafId) {
        return
      }
      if (effectiveChatViewMode && chatLeafId === activeLeafId) {
        setChatLeafId(null)
        setTabViewMode(unifiedTabId, 'terminal')
      } else {
        setChatLeafId(activeLeafId)
        setTabViewMode(unifiedTabId, 'chat')
      }
    }
    window.addEventListener(NATIVE_CHAT_TOGGLE_REQUEST_EVENT, handleRequest)
    return () => window.removeEventListener(NATIVE_CHAT_TOGGLE_REQUEST_EVENT, handleRequest)
  }, [
    chatLeafId,
    effectiveChatViewMode,
    managerRef,
    setChatLeafId,
    setTabViewMode,
    tabId,
    unifiedTabId
  ])
}
