import type { MutableRefObject } from 'react'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '../../store'

const NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS = 50

export function focusNewActiveTerminalWhenReady(
  retryRef: MutableRefObject<number | null>,
  previousActiveTabId: string | null,
  expiresAt: number,
  now: number
): void {
  const state = useAppStore.getState()
  if (
    (state.activeTabType === 'terminal' || state.activeTabType === 'simulator') &&
    state.activeTabId &&
    state.activeTabId !== previousActiveTabId
  ) {
    focusTerminalTabSurface(state.activeTabId)
    return
  }
  if (now >= expiresAt) {
    return
  }
  retryRef.current = window.setTimeout(() => {
    retryRef.current = null
    focusNewActiveTerminalWhenReady(retryRef, previousActiveTabId, expiresAt, Date.now())
  }, NEW_TAB_MENU_TERMINAL_FOCUS_RETRY_MS)
}
