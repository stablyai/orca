import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  BrowserGrabPayload,
  BrowserGrabRejectReason,
  BrowserGrabResult,
  BrowserGrabScreenshot,
  BrowserSetGrabModeResult
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { isEditableKeyboardTarget } from '../../host-guest/input/browser-keyboard'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { useGuestEscape } from '../../host-guest/input/use-guest-escape'
import {
  ipcBrowserGuestToolsTransport,
  type BrowserGuestToolsTransport
} from '../browser-guest-tools-transport'
import { interceptAnnotateEscape } from '../palette/annotate-escape-interceptor'
import { keyEventBelongsToOtherAnnotatePage } from '../palette/annotate-esc-ownership'

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
  getOperationToken: () => number
  isCurrentOperationToken: (token: number) => boolean
  transport: BrowserGuestToolsTransport
  browserPageId?: string
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

export function useGrabMode(
  browserPageId: string,
  transport: BrowserGuestToolsTransport = ipcBrowserGuestToolsTransport
): GrabModeHook {
  const [state, setState] = useState<GrabModeState>('idle')
  const [payload, setPayload] = useState<BrowserGrabPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState(false)
  const activeRequestIdRef = useRef<string | null>(null)
  const activeOpIdRef = useRef<string | null>(null)
  const grabTabIdRef = useRef<string | null>(null)
  const armGenerationRef = useRef(0)
  const browserTabIdRef = useRef(browserPageId)
  const mountedRef = useMountedRef()

  const getOperationToken = useCallback((): number => armGenerationRef.current, [])
  const isCurrentOperationToken = useCallback(
    (token: number): boolean =>
      mountedRef.current &&
      armGenerationRef.current === token &&
      grabTabIdRef.current !== null &&
      grabTabIdRef.current === browserTabIdRef.current,
    [mountedRef]
  )

  useLayoutEffect(() => {
    browserTabIdRef.current = browserPageId
  }, [browserPageId, transport])

  // Cancel on page departure so overlays cannot survive on another tab.
  useEffect(() => {
    return () => {
      const grabTabId = grabTabIdRef.current
      if (grabTabId) {
        armGenerationRef.current += 1
        void transport
          .cancelGrab({
            browserPageId: grabTabId,
            requestId: activeRequestIdRef.current ?? undefined
          })
          .catch(() => {})
        activeRequestIdRef.current = null
        grabTabIdRef.current = null
        activeOpIdRef.current = null
      }
    }
  }, [browserPageId, transport])

  const armAndAwait = useCallback(async () => {
    const tabId = browserPageId
    const armGeneration = (armGenerationRef.current += 1)
    grabTabIdRef.current = tabId
    setState('armed')
    const requestId = nextOpId()
    activeRequestIdRef.current = requestId

    // A rejected invoke (lost reply) must end in the error state, not a stuck 'armed'.
    const setResult = await transport
      .setGrabMode({ browserPageId: tabId, enabled: true, requestId })
      .catch((): BrowserSetGrabModeResult => ({ ok: false, reason: 'injection-failed' }))
    if (
      !mountedRef.current ||
      armGenerationRef.current !== armGeneration ||
      browserTabIdRef.current !== tabId ||
      grabTabIdRef.current !== tabId
    ) {
      const supersededBySameTab =
        armGenerationRef.current !== armGeneration && grabTabIdRef.current === tabId
      if (!supersededBySameTab) {
        void transport.cancelGrab({ browserPageId: tabId, requestId }).catch(() => {})
        if (grabTabIdRef.current === tabId) {
          grabTabIdRef.current = null
        }
      }
      return
    }
    if (!setResult.ok) {
      void transport.cancelGrab({ browserPageId: tabId, requestId }).catch(() => {})
      activeRequestIdRef.current = null
      grabTabIdRef.current = null
      setState('error')
      setError(getGrabEnableError(setResult.reason))
      return
    }

    const opId = nextOpId()
    activeOpIdRef.current = opId

    setState('awaiting')
    const result = await transport
      .awaitGrabSelection({ browserPageId: tabId, opId, requestId })
      .catch((): BrowserGrabResult => ({ opId, kind: 'error', reason: 'Selection failed' }))

    if (!mountedRef.current || activeOpIdRef.current !== opId || grabTabIdRef.current !== tabId) {
      return
    }

    activeOpIdRef.current = null

    if (result.kind === 'selected' || result.kind === 'context-selected') {
      let screenshot: BrowserGrabScreenshot | null = null
      try {
        const ssResult = await transport.captureSelectionScreenshot({
          browserPageId: tabId,
          rect: result.payload.target.rectViewport,
          selectionId: result.payload.page.selectionId
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
  }, [browserPageId, mountedRef, transport])

  const cancel = useCallback(() => {
    const targetTabId = grabTabIdRef.current
    armGenerationRef.current += 1
    // Navigation cancels every page's capture; an idle page has nothing in main to tear down.
    if (targetTabId !== null) {
      void transport
        .cancelGrab({
          browserPageId: targetTabId,
          requestId: activeRequestIdRef.current ?? undefined
        })
        .catch(() => {})
    }
    activeRequestIdRef.current = null
    activeOpIdRef.current = null
    grabTabIdRef.current = null
    setState('idle')
    setPayload(null)
    setError(null)
    setContextMenu(false)
  }, [transport])

  useEffect(() => {
    if (state !== 'confirming' || !payload) {
      return
    }
    let live = true
    let checking = false
    const stop = installWindowVisibilityInterval({
      intervalMs: 300,
      slowWhileUnfocused: true,
      run: () => {
        if (checking) {
          return
        }
        checking = true
        void transport
          .grabPickedElementPresent({
            browserPageId,
            selectionId: payload.page.selectionId ?? payload.page.capturedAt
          })
          .catch(() => null)
          .then((present) => {
            checking = false
            if (live && present === false) {
              cancel()
            }
          })
      }
    })
    return () => {
      live = false
      stop()
    }
  }, [browserPageId, cancel, payload, state, transport])

  useEffect(
    () =>
      transport.onGrabPolicyRetired?.((args) => {
        if (args.browserPageId === browserPageId && args.requestId === activeRequestIdRef.current) {
          cancel()
          setState('error')
          setError(getGrabEnableError('injection-failed'))
        }
      }),
    [browserPageId, cancel, transport]
  )

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

  const exit = cancel

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state !== 'idle') {
        // IME composition ends on Esc; another page's pane or palette has its own owner.
        if (
          e.isComposing ||
          e.keyCode === 229 ||
          keyEventBelongsToOtherAnnotatePage(e.target, browserPageId)
        ) {
          return
        }
        const element =
          e.target && typeof e.target === 'object' && 'closest' in e.target
            ? (e.target as { closest: (selector: string) => unknown })
            : null
        if (
          isEditableKeyboardTarget(e.target) ||
          element?.closest(
            // An open menu or popover (the palette's Send menu, Draw's style popover) closes first.
            '[data-slot="select-trigger"], [data-slot="select-content"], [data-slot="annotation-edit"], [data-slot="dialog-content"], [data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="browser-annotation-tray"]'
          )
        ) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        // An open notes list takes this Esc first; the next one leaves the mode.
        if (interceptAnnotateEscape(browserPageId)) {
          return
        }
        cancel()
      }
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [browserPageId, state, cancel])

  // Includes the copy toast's wait before rearming, while the page still has focus.
  const cancelUnlessIntercepted = useCallback(() => {
    if (!interceptAnnotateEscape(browserPageId)) {
      cancel()
    }
  }, [browserPageId, cancel])
  useGuestEscape(browserPageId, state !== 'idle', cancelUnlessIntercepted)

  return {
    state,
    payload,
    error,
    contextMenu,
    toggle,
    cancel,
    rearm,
    exit,
    getOperationToken,
    isCurrentOperationToken,
    transport,
    browserPageId
  }
}
