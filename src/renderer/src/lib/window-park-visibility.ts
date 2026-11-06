import { isWindowVisible } from './window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/stale-document-visibility'

// macOS can latch visibilityState hidden without later events; stale-latch proof prevents parking visible work forever, including terminal output.
export function getWindowParkVisible(): boolean {
  return isWindowVisible() || isDocumentVisibilityProvenStale()
}

export function subscribeWindowParkVisibility(onChange: () => void): () => void {
  // Subscribe stale-latch handling first so visibilitychange clears it before onChange reads the signal.
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

// Share grace for quick app-switch round trips across park sites; expensive resume paths may add their own backoff.
export const WINDOW_HIDE_PARK_GRACE_MS = 500
