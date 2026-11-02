import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  BrowserGrabPayload,
  BrowserGrabRejectReason,
  BrowserGrabScreenshot
} from '../../../../../shared/browser-grab-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { isEditableKeyboardTarget } from '../host-guest/browser-keyboard'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export type GrabModeState = 'idle' | 'armed' | 'awaiting' | 'confirming' | 'error'

export type GrabModeHook = {
  state: GrabModeState
  payload: BrowserGrabPayload | null
  error: string | null
  /** Right-click selection opens the full action menu instead of auto-copying. */
  contextMenu: boolean
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

function getGrabEnableError(reason: BrowserGrabRejectReason): string {
  switch (reason) {
    case 'not-ready':
      return translate(
        'auto.components.browser-pane.grab.errorNotReady',
        "This page isn't ready for element selection yet."
      )
    case 'not-authorized':
      return translate(
        'auto.components.browser-pane.grab.errorNotAuthorized',
        'Browser access was denied.'
      )
    case 'already-active':
      return translate(
        'auto.components.browser-pane.grab.errorAlreadyActive',
        'Element selection is already active.'
      )
    case 'injection-failed':
      return translate(
        'auto.components.browser-pane.grab.errorInjectionFailed',
        'Could not start element selection on this page.'
      )
  }
}

export function useGrabMode(browserPageId: string): GrabModeHook {
  const [state, setState] = useState<GrabModeState>('idle')
  const [payload, setPayload] = useState<BrowserGrabPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState(false)
  const activeOpIdRef = useRef<string | null>(null)
  const grabTabIdRef = useRef<string | null>(null)
  const armGenerationRef = useRef(0)
  const browserTabIdRef = useRef(browserPageId)
  const mountedRef = useMountedRef()

  useLayoutEffect(() => {
    browserTabIdRef.current = browserPageId
  }, [browserPageId])

  // Cancel on page departure so overlays cannot survive on another tab.
  useEffect(() => {
    return () => {
      const grabTabId = grabTabIdRef.current
      if (grabTabId) {
        armGenerationRef.current += 1
        void window.api.browser.setGrabMode({ browserPageId: grabTabId, enabled: false })
        void window.api.browser.cancelGrab({ browserPageId: grabTabId })
        grabTabIdRef.current = null
        activeOpIdRef.current = null
      }
    }
  }, [browserPageId])

  const armAndAwait = useCallback(async () => {
    const tabId = browserPageId
    const armGeneration = (armGenerationRef.current += 1)
    grabTabIdRef.current = tabId
    setState('armed')

    const setResult = await window.api.browser.setGrabMode({
      browserPageId: tabId,
      enabled: true
    })
    if (
      !mountedRef.current ||
      armGenerationRef.current !== armGeneration ||
      browserTabIdRef.current !== tabId ||
      grabTabIdRef.current !== tabId
    ) {
      const supersededBySameTab =
        armGenerationRef.current !== armGeneration && grabTabIdRef.current === tabId
      if (!supersededBySameTab) {
        void window.api.browser.setGrabMode({ browserPageId: tabId, enabled: false })
        void window.api.browser.cancelGrab({ browserPageId: tabId })
        if (grabTabIdRef.current === tabId) {
          grabTabIdRef.current = null
        }
      }
      return
    }
    if (!setResult.ok) {
      grabTabIdRef.current = null
      setState('error')
      setError(getGrabEnableError(setResult.reason))
      return
    }

    const opId = nextOpId()
    activeOpIdRef.current = opId

    setState('awaiting')
    const result = await window.api.browser.awaitGrabSelection({
      browserPageId: tabId,
      opId
    })

    if (!mountedRef.current || activeOpIdRef.current !== opId || grabTabIdRef.current !== tabId) {
      return
    }

    activeOpIdRef.current = null

    if (result.kind === 'selected' || result.kind === 'context-selected') {
      let screenshot: BrowserGrabScreenshot | null = null
      try {
        const ssResult = await window.api.browser.captureSelectionScreenshot({
          browserPageId: tabId,
          rect: result.payload.target.rectViewport
        })
        if (ssResult.ok) {
          screenshot = ssResult.screenshot as BrowserGrabScreenshot
        }
      } catch {
        // Screenshot failure is non-fatal
      }
      if (
        !mountedRef.current ||
        armGenerationRef.current !== armGeneration ||
        grabTabIdRef.current !== tabId
      ) {
        return
      }

      setContextMenu(result.kind === 'context-selected')
      setPayload({ ...result.payload, screenshot })
      setState('confirming')
    } else if (result.kind === 'cancelled') {
      grabTabIdRef.current = null
      setState('idle')
      setPayload(null)
    } else {
      grabTabIdRef.current = null
      setState('error')
      setError(result.reason)
    }
  }, [browserPageId, mountedRef])

  const cancel = useCallback(() => {
    const targetTabId = grabTabIdRef.current ?? browserPageId
    armGenerationRef.current += 1
    void window.api.browser.setGrabMode({
      browserPageId: targetTabId,
      enabled: false
    })
    if (activeOpIdRef.current) {
      void window.api.browser.cancelGrab({
        browserPageId: targetTabId
      })
      activeOpIdRef.current = null
    }
    grabTabIdRef.current = null
    setState('idle')
    setPayload(null)
    setError(null)
    setContextMenu(false)
  }, [browserPageId])

  const toggle = useCallback(() => {
    if ((state === 'idle' || state === 'error') && grabTabIdRef.current === null) {
      setError(null)
      setPayload(null)
      setContextMenu(false)
      void armAndAwait()
    } else {
      cancel()
    }
  }, [state, armAndAwait, cancel])

  // Copy rearms for another pick; attaching exits so the user can continue in chat.
  const rearm = useCallback(() => {
    // Close the confirming menu before async rearm IPC; otherwise it flashes during the gap.
    setState('armed')
    setPayload(null)
    setError(null)
    setContextMenu(false)
    void armAndAwait()
  }, [armAndAwait])

  const exit = useCallback(() => {
    const targetTabId = grabTabIdRef.current ?? browserTabIdRef.current
    armGenerationRef.current += 1
    void window.api.browser.setGrabMode({
      browserPageId: targetTabId,
      enabled: false
    })
    // Invalidate prior in-flight selections before exiting.
    activeOpIdRef.current = null
    grabTabIdRef.current = null
    setState('idle')
    setPayload(null)
    setError(null)
    setContextMenu(false)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state !== 'idle') {
        const element =
          e.target && typeof e.target === 'object' && 'closest' in e.target
            ? (e.target as { closest: (selector: string) => unknown })
            : null
        if (
          isEditableKeyboardTarget(e.target) ||
          element?.closest(
            '[data-slot="select-trigger"], [data-slot="select-content"], [data-slot="annotation-edit"], [data-slot="dialog-content"]'
          )
        ) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [state, cancel])

  return { state, payload, error, contextMenu, toggle, cancel, rearm, exit }
}
