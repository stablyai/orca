import { useSyncExternalStore } from 'react'
import { isOrcaWindowForegroundFocused } from '@/components/terminal-pane/terminal-notification-pane-visibility'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  document.addEventListener('visibilitychange', onChange)
  return () => {
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
    document.removeEventListener('visibilitychange', onChange)
  }
}

const subscribeToNothing = (): (() => void) => () => {}
const notFocused = (): boolean => false

/** Track foreground focus only while enabled; hidden panes return false without window-switch subscriptions. */
export function useOrcaWindowForegroundFocused(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    enabled ? isOrcaWindowForegroundFocused : notFocused
  )
}
