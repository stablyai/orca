import { isWindowVisible } from './window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/stale-document-visibility'

// Why the stale-latch term is load-bearing: macOS can wedge document.visibilityState at 'hidden'
// with no further visibilitychange, so a window the user is looking at would park its work
// forever (same bug class as the field report of 78MB of terminal bytes dropped on visible ptys).
export function getWindowParkVisible(): boolean {
  return isWindowVisible() || isDocumentVisibilityProvenStale()
}

export function subscribeWindowParkVisibility(onChange: () => void): () => void {
  // Why: the stale latch flips to proven-visible without emitting a visibilitychange, and
  // registering it first lets its own visibilitychange handler clear the latch before `onChange`
  // reads it.
  const unregisterStaleRecovery = registerStaleDocumentVisibilityRecovery(onChange)
  const canListenToVisibility =
    typeof document !== 'undefined' && typeof document.addEventListener === 'function'
  if (canListenToVisibility) {
    document.addEventListener('visibilitychange', onChange)
  }
  return () => {
    if (canListenToVisibility) {
      document.removeEventListener('visibilitychange', onChange)
    }
    unregisterStaleRecovery()
  }
}

// Why: every park site debounces this one signal against the same user behaviour — a quick
// app-switch round trip — so the grace period is one number. Only the cost of resuming differs,
// and sites that pay a steep one layer their own backoff on top of this base.
export const WINDOW_HIDE_PARK_GRACE_MS = 500
