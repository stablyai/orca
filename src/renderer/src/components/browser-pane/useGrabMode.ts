import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrowserGrabPayload,
  BrowserGrabScreenshot
} from '../../../../shared/browser-grab-types'

// ---------------------------------------------------------------------------
// Grab mode state machine
// ---------------------------------------------------------------------------

export type GrabModeState = 'idle' | 'armed' | 'awaiting' | 'confirming' | 'error'

export type GrabModeHook = {
  state: GrabModeState
  payload: BrowserGrabPayload | null
  error: string | null
  toggle: () => void
  cancel: () => void
  /** Called after Copy — re-arms grab for another pick. */
  rearm: () => void
  /** Called after Attach to AI — exits grab mode entirely. */
  exit: () => void
}

let opIdCounter = 0
function nextOpId(): string {
  return `grab-${++opIdCounter}-${Date.now()}`
}

/**
 * Hook that drives the browser grab lifecycle for a single browser tab.
 *
 * The state machine: idle → armed → awaiting → confirming → idle/armed
 *                                                        ↘ error → idle
 */
export function useGrabMode(browserTabId: string): GrabModeHook {
  const [state, setState] = useState<GrabModeState>('idle')
  const [payload, setPayload] = useState<BrowserGrabPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeOpIdRef = useRef<string | null>(null)
  const browserTabIdRef = useRef(browserTabId)

  useEffect(() => {
    browserTabIdRef.current = browserTabId
  }, [browserTabId])

  // Why: when the browser tab changes while grab is active, cancel the
  // current grab operation so stale overlays don't survive tab switches.
  useEffect(() => {
    return () => {
      if (activeOpIdRef.current) {
        void window.api.browser.cancelGrab({ browserTabId })
        activeOpIdRef.current = null
      }
    }
  }, [browserTabId])

  const armAndAwait = useCallback(async () => {
    const tabId = browserTabIdRef.current

    // Enable grab mode — injects the overlay
    const setResult = await window.api.browser.setGrabMode({
      browserTabId: tabId,
      enabled: true
    })
    if (!setResult.ok) {
      setState('error')
      setError(`Cannot enable grab mode: ${setResult.reason}`)
      return
    }

    setState('armed')

    // Generate opId and await selection
    const opId = nextOpId()
    activeOpIdRef.current = opId

    setState('awaiting')
    const result = await window.api.browser.awaitGrabSelection({
      browserTabId: tabId,
      opId
    })

    // Ignore stale results
    if (activeOpIdRef.current !== opId) {
      return
    }

    activeOpIdRef.current = null

    if (result.kind === 'selected') {
      // Capture screenshot for the selected element
      let screenshot: BrowserGrabScreenshot | null = null
      try {
        const ssResult = await window.api.browser.captureSelectionScreenshot({
          browserTabId: tabId,
          rect: result.payload.target.rectViewport
        })
        if (ssResult.ok) {
          screenshot = ssResult.screenshot as BrowserGrabScreenshot
        }
      } catch {
        // Screenshot failure is non-fatal
      }

      setPayload({ ...result.payload, screenshot })
      setState('confirming')
    } else if (result.kind === 'cancelled') {
      setState('idle')
      setPayload(null)
    } else {
      setState('error')
      setError(result.reason)
    }
  }, [])

  const toggle = useCallback(() => {
    if (state === 'idle' || state === 'error') {
      setError(null)
      setPayload(null)
      void armAndAwait()
    } else {
      // Disable grab mode
      void window.api.browser.setGrabMode({
        browserTabId: browserTabIdRef.current,
        enabled: false
      })
      if (activeOpIdRef.current) {
        void window.api.browser.cancelGrab({
          browserTabId: browserTabIdRef.current
        })
        activeOpIdRef.current = null
      }
      setState('idle')
      setPayload(null)
      setError(null)
    }
  }, [state, armAndAwait])

  const cancel = useCallback(() => {
    void window.api.browser.setGrabMode({
      browserTabId: browserTabIdRef.current,
      enabled: false
    })
    if (activeOpIdRef.current) {
      void window.api.browser.cancelGrab({
        browserTabId: browserTabIdRef.current
      })
      activeOpIdRef.current = null
    }
    setState('idle')
    setPayload(null)
    setError(null)
  }, [])

  // Why: Copy re-arms so the user can quickly pick another element without
  // re-clicking the toolbar button. Attach to AI exits because the user's
  // intent is to continue in the chat, not keep selecting.
  const rearm = useCallback(() => {
    // Why: set state to 'armed' immediately so the dropdown menu closes
    // before armAndAwait starts its async IPC calls. Without this, the state
    // stays 'confirming' during the gap, causing the dropdown to flash.
    setState('armed')
    setPayload(null)
    setError(null)
    void armAndAwait()
  }, [armAndAwait])

  const exit = useCallback(() => {
    void window.api.browser.setGrabMode({
      browserTabId: browserTabIdRef.current,
      enabled: false
    })
    // Why: clear the active opId so that any in-flight result from the
    // previous operation is ignored by the stale-opId check in armAndAwait.
    activeOpIdRef.current = null
    setState('idle')
    setPayload(null)
    setError(null)
  }, [])

  // Keyboard shortcut: Esc cancels grab mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state !== 'idle') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [state, cancel])

  return { state, payload, error, toggle, cancel, rearm, exit }
}
