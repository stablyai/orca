import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility,
  WINDOW_HIDE_PARK_GRACE_MS
} from '@/lib/window-park-visibility'

// Avoid renegotiating expensive streams during a quick app-switch round trip.
export const WINDOW_STREAM_PARK_DELAY_MS = WINDOW_HIDE_PARK_GRACE_MS

export function useWindowStreamVisible(parkDelayMs = WINDOW_STREAM_PARK_DELAY_MS): boolean {
  const rawVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    getWindowParkVisible
  )
  const [effectiveVisible, setEffectiveVisible] = useState(rawVisible)

  useEffect(() => {
    if (rawVisible) {
      setEffectiveVisible(true)
      return
    }
    const timer = window.setTimeout(() => setEffectiveVisible(false), parkDelayMs)
    return () => window.clearTimeout(timer)
  }, [parkDelayMs, rawVisible])

  return effectiveVisible
}
