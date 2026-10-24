import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopAppTarget, DesktopAppWindow } from '../../../../shared/desktop-app-types'
import { errorMessage } from '../../../../shared/error-message'
import {
  findExactWindow,
  findRememberedWindow,
  readRememberedTarget,
  writeRememberedTarget
} from './desktop-app-target-memory'

// Why: the user can move or resize the real window; its size sets the click mapping.
const WINDOW_REFRESH_MS = 3_000

export type DesktopAppWindowsState = {
  windows: DesktopAppWindow[]
  selected: DesktopAppWindow | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  select: (target: DesktopAppTarget) => void
}

export function useDesktopAppWindows(tabId: string, isActive: boolean): DesktopAppWindowsState {
  const [windows, setWindows] = useState<DesktopAppWindow[]>([])
  const [selected, setSelected] = useState<DesktopAppWindow | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The window the user chose (or a restore resolved to); only this exact pid + window id is shown.
  const chosen = useRef<DesktopAppTarget | null>(null)
  const restoreAttempted = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.api.desktopApp.listWindows()
      setWindows(next)
      setError(null)
      if (!chosen.current && !restoreAttempted.current) {
        restoreAttempted.current = true
        const remembered = readRememberedTarget(tabId)
        // Why: ids do not survive an app relaunch, so a restore may settle on the same app's
        // window; from then on that exact window is the choice.
        const restored = remembered ? findRememberedWindow(next, remembered) : null
        if (restored) {
          chosen.current = { windowId: restored.windowId, pid: restored.pid }
          writeRememberedTarget(tabId, rememberedTarget(restored))
        }
      }
      // Why: a chosen window that is minimized or hidden drops out of the list. It
      // comes back when listed again, and input never moves to a different window meanwhile.
      setSelected(chosen.current ? findExactWindow(next, chosen.current) : null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [tabId])

  useEffect(() => {
    if (!isActive) {
      return
    }
    void refresh()
    const timer = setInterval(() => void refresh(), WINDOW_REFRESH_MS)
    return () => clearInterval(timer)
  }, [isActive, refresh])

  const select = useCallback(
    (target: DesktopAppTarget) => {
      const next = findExactWindow(windows, target)
      if (!next) {
        return
      }
      chosen.current = { windowId: next.windowId, pid: next.pid }
      setSelected(next)
      writeRememberedTarget(tabId, rememberedTarget(next))
    },
    [tabId, windows]
  )

  return { windows, selected, loading, error, refresh, select }
}

function rememberedTarget({ windowId, pid, appName, bundleId, title }: DesktopAppWindow) {
  return { windowId, pid, appName, bundleId, title }
}
