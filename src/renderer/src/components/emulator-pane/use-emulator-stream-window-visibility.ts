import { useEffect, useState, useSyncExternalStore } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '../terminal-pane/stale-document-visibility'

// Why: after display sleep macOS can wedge document.visibilityState at 'hidden'
// with no further visibilitychange event; honor the terminal occlusion-staleness
// latch so a window the user is actually looking at is never treated as hidden —
// otherwise the emulator freezes on a black frame with no recovery (same bug class
// as the 78MB terminal drop that motivated the latch).
function getWindowVisibleSnapshot(): boolean {
  return isWindowVisible() || isDocumentVisibilityProvenStale()
}

function subscribeWindowVisible(onChange: () => void): () => void {
  const handler = (): void => onChange()
  document.addEventListener('visibilitychange', handler)
  // Why: the stale latch flips visibility to proven-visible without emitting a
  // visibilitychange, so recompute when it fires too.
  const unregister = registerStaleDocumentVisibilityRecovery(handler)
  return () => {
    document.removeEventListener('visibilitychange', handler)
    unregister()
  }
}

// Why: parking is delayed so a quick Cmd+Tab / app-switch round-trip does not tear
// down and renegotiate the device stream (MJPEG reconnect or scrcpy H.264 keyframe),
// which is heavier than a terminal resync and flashes the "Connecting…" UI. Re-showing
// restores immediately.
export const EMULATOR_STREAM_PARK_DELAY_MS = 500

/**
 * Reactive "is this window visible enough to keep the emulator device stream
 * running" signal. Returns true while the window is visible (or occlusion state is
 * proven stale) and defers the visible→hidden transition by `parkDelayMs`.
 */
export function useEmulatorStreamWindowVisible(
  parkDelayMs = EMULATOR_STREAM_PARK_DELAY_MS
): boolean {
  const rawVisible = useSyncExternalStore(
    subscribeWindowVisible,
    getWindowVisibleSnapshot,
    getWindowVisibleSnapshot
  )
  const [effectiveVisible, setEffectiveVisible] = useState(rawVisible)
  useEffect(() => {
    if (rawVisible) {
      // Restore immediately so returning to the window resumes without delay.
      setEffectiveVisible(true)
      return
    }
    const timer = window.setTimeout(() => setEffectiveVisible(false), parkDelayMs)
    return () => window.clearTimeout(timer)
  }, [rawVisible, parkDelayMs])
  return effectiveVisible
}
