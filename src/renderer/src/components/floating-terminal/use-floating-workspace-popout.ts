import { useCallback, useEffect, useRef, useState } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import {
  findNextDisplay,
  type WorkspaceDisplayInfo
} from '../../../../shared/floating-workspace-display'
import { captureAllLiveBrowserPageProgress } from '../browser-pane/host-guest/browser-page-progress-retention'
import { setFloatingWorkspacePopoutDetached } from './floating-workspace-popout-shared-state'
import { syncPopoutStyles } from './floating-workspace-popout-styles'

export function useFloatingWorkspacePopout() {
  const [isDetached, setIsDetached] = useState(false)
  const [displays, setDisplays] = useState<WorkspaceDisplayInfo[]>([])
  const [currentDisplayId, setCurrentDisplayId] = useState<number | null>(null)
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const [popupWindow, setPopupWindow] = useState<Window | null>(null)
  const popupRef = useRef<Window | null>(null)
  const refreshTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    void window.api?.floatingWorkspace?.getDisplays?.().then((result) => {
      if (active && Array.isArray(result)) {
        setDisplays(result)
      }
    })

    const unsubscribe = window.api?.floatingWorkspace?.onDisplaysChanged?.((updated) => {
      if (active && Array.isArray(updated)) {
        setDisplays(updated)
      }
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const refreshCurrentDisplayId = useCallback((): void => {
    void window.api?.floatingWorkspace?.getCurrentDisplayId?.().then((id) => {
      if (typeof id === 'number' || id === null) {
        setCurrentDisplayId(id)
      }
    })
  }, [])

  const dock = useCallback(async (): Promise<void> => {
    // Why: the capture runs executeJavaScript against live guests — closing the
    // popout first destroys them and loses the scroll/playback state.
    await captureAllLiveBrowserPageProgress()
    if (refreshTimeoutRef.current !== null) {
      window.clearTimeout(refreshTimeoutRef.current)
      refreshTimeoutRef.current = null
    }
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close()
    }
    popupRef.current = null
    setPopupWindow(null)
    setPortalContainer(null)
    setIsDetached(false)
    setCurrentDisplayId(null)
  }, [])

  const detach = useCallback(
    (targetDisplayId?: number): void => {
      void captureAllLiveBrowserPageProgress()
      if (popupRef.current && !popupRef.current.closed) {
        const live = popupRef.current
        // Why: after a popout reload the old container is detached — re-query it.
        let container = live.document.getElementById('floating-workspace-portal-root')
        if (!container) {
          container = live.document.createElement('div')
          container.id = 'floating-workspace-portal-root'
          container.className = 'h-full w-full'
          live.document.body.appendChild(container)
        }
        live.document.documentElement.className = document.documentElement.className
        live.document.documentElement.style.cssText = document.documentElement.style.cssText
        if (syncPopoutStyles(document, live.document.head)) {
          window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
        }
        setPortalContainer(container)
        setPopupWindow(live)
        setIsDetached(true)
        live.focus()
        if (typeof targetDisplayId === 'number') {
          void window.api?.floatingWorkspace?.moveToDisplay?.(targetDisplayId).then(() => {
            setCurrentDisplayId(targetDisplayId)
          })
        }
        return
      }

      const targetDisplay =
        typeof targetDisplayId === 'number' ? displays.find((d) => d.id === targetDisplayId) : null
      const features = targetDisplay
        ? `left=${targetDisplay.workArea.x + Math.max(0, Math.round((targetDisplay.workArea.width - 960) / 2))},top=${targetDisplay.workArea.y + Math.max(0, Math.round((targetDisplay.workArea.height - 640) / 2))},width=960,height=640`
        : 'width=960,height=640'

      const popup = window.open(
        'about:blank#floating-workspace',
        'orca-floating-workspace',
        features
      )

      if (!popup) {
        console.warn('[floating-workspace] Failed to open popout window')
        return
      }

      popupRef.current = popup

      try {
        popup.document.title = 'Orca - Floating Workspace'

        // Why: deduped helper — raw-href keys, stale prune, source order.
        syncPopoutStyles(document, popup.document.head)

        popup.document.documentElement.className = document.documentElement.className
        popup.document.documentElement.style.cssText = document.documentElement.style.cssText
        popup.document.body.className =
          'm-0 p-0 overflow-hidden bg-background text-foreground h-screen w-screen'

        let container = popup.document.getElementById('floating-workspace-portal-root')
        if (!container) {
          container = popup.document.createElement('div')
          container.id = 'floating-workspace-portal-root'
          container.className = 'h-full w-full'
          popup.document.body.appendChild(container)
        }

        setPortalContainer(container)
        setIsDetached(true)
        setPopupWindow(popup)

        if (typeof targetDisplayId === 'number') {
          setCurrentDisplayId(targetDisplayId)
          if (refreshTimeoutRef.current !== null) {
            window.clearTimeout(refreshTimeoutRef.current)
          }
          refreshTimeoutRef.current = window.setTimeout(() => {
            void window.api?.floatingWorkspace?.moveToDisplay?.(targetDisplayId)
          }, 50)
        } else {
          if (refreshTimeoutRef.current !== null) {
            window.clearTimeout(refreshTimeoutRef.current)
          }
          refreshTimeoutRef.current = window.setTimeout(refreshCurrentDisplayId, 50)
        }
      } catch (err) {
        console.warn('[floating-workspace] Error setting up popout document:', err)
        // Why: without a container the window is unusable — dock is dead and the
        // next detach opens a second window, so close it instead of orphaning.
        try {
          popup.close()
        } catch {
          // Already closed or teardown failed — clearing state below covers it.
        }
        setIsDetached(false)
        setPortalContainer(null)
        setPopupWindow(null)
        popupRef.current = null
        setCurrentDisplayId(null)
      }
    },
    [displays, refreshCurrentDisplayId]
  )

  useEffect(() => {
    if (!popupWindow) {
      return
    }

    const handleUnload = (): void => {
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current)
        refreshTimeoutRef.current = null
      }
      setIsDetached(false)
      setPortalContainer(null)
      setPopupWindow(null)
      popupRef.current = null
      setCurrentDisplayId(null)
    }
    popupWindow.addEventListener('beforeunload', handleUnload)
    // Why: OS-chrome close can skip beforeunload — poll closed instead.
    const closedPollId = window.setInterval(() => {
      if (popupWindow.closed) {
        handleUnload()
      }
    }, 500)
    const syncTheme = (): void => {
      if (!popupWindow.closed) {
        popupWindow.document.documentElement.className = document.documentElement.className
        popupWindow.document.documentElement.style.cssText = document.documentElement.style.cssText
      }
    }
    const syncStyles = (): void => {
      if (popupWindow.closed) {
        return
      }
      syncTheme()
      // Why: a late sheet changes cell metrics with no resize — refit once it lands.
      if (syncPopoutStyles(document, popupWindow.document.head)) {
        window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
      }
    }
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    const headObserver = new MutationObserver(syncStyles)
    if (document.head) {
      headObserver.observe(document.head, { childList: true })
    }
    return () => {
      try {
        popupWindow.removeEventListener('beforeunload', handleUnload)
      } catch {
        // window may already be closed
      }
      window.clearInterval(closedPollId)
      observer.disconnect()
      headObserver.disconnect()
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current)
        refreshTimeoutRef.current = null
      }
      if (!popupWindow.closed) {
        popupWindow.close()
      }
    }
  }, [popupWindow])

  useEffect(() => {
    setFloatingWorkspacePopoutDetached(isDetached)
    return () => setFloatingWorkspacePopoutDetached(false)
  }, [isDetached])

  useEffect(() => {
    if (!isDetached || !portalContainer) {
      return
    }
    const view = portalContainer.ownerDocument.defaultView ?? window
    if (typeof view.requestAnimationFrame !== 'function') {
      return
    }
    // Why: the portal commits before the popup applies cloned sheets — fit next frame so panes measure styled boxes.
    const frameId = view.requestAnimationFrame(() => {
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
    })
    return () => view.cancelAnimationFrame(frameId)
  }, [isDetached, portalContainer])

  const moveToNextDisplay = useCallback((): void => {
    void captureAllLiveBrowserPageProgress()
    if (!isDetached) {
      // Why: the detached IPC path already prefers the first secondary on unknown displays.
      const nextDisplay = findNextDisplay(displays, currentDisplayId)
      if (!nextDisplay) {
        return
      }
      detach(nextDisplay.id)
      return
    }
    void window.api?.floatingWorkspace?.moveToNextDisplay?.().then(() => {
      refreshCurrentDisplayId()
    })
  }, [currentDisplayId, detach, displays, isDetached, refreshCurrentDisplayId])

  const moveToDisplay = useCallback(
    (displayId: number): void => {
      void captureAllLiveBrowserPageProgress()
      if (!isDetached) {
        detach(displayId)
        return
      }
      void window.api?.floatingWorkspace?.moveToDisplay?.(displayId).then(() => {
        setCurrentDisplayId(displayId)
      })
    },
    [detach, isDetached]
  )

  const identifyDisplays = useCallback((): void => {
    void window.api?.floatingWorkspace?.identifyDisplays?.()
  }, [])

  const minimize = useCallback((): void => {
    void window.api?.floatingWorkspace?.minimize?.()
  }, [])

  return {
    isDetached,
    displays,
    currentDisplayId,
    portalContainer,
    detach,
    dock,
    moveToNextDisplay,
    moveToDisplay,
    identifyDisplays,
    refreshCurrentDisplayId,
    minimize
  }
}
