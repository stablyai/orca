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

/** Whether the Orca window is the one in front and focused. `enabled` off reads false and
 *  listens to nothing, so a pane that is not showing never re-renders on a window switch. */
export function useOrcaWindowForegroundFocused(enabled: boolean): boolean {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    enabled ? isOrcaWindowForegroundFocused : notFocused
  )
}
