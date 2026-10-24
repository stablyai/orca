import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject
} from 'react'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import {
  consumeBrowserFocusRequest,
  queueBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from '../host-guest/browser-focus'
import { browserChromeShortcutOwnsEvent } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import type { BrowserAddressBarSelection } from './browser-address-bar-edit-session'
import type { BrowserPageGuestFocus } from './browser-page-guest-focus'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { useBrowserHistoryShortcut } from '../history/use-browser-history-shortcut'

/** Frames an address-bar grab keeps retrying before it lets the guest have focus back. */
const ADDRESS_BAR_FOCUS_FRAMES = 6
/** Frames a queued page-focus request waits for a new tab's guest to attach. */
const GUEST_ATTACH_WAIT_FRAMES = 120

/**
 * Who owns focus in a browser pane's chrome. Every pane — local, client-hosted and streamed —
 * uses this so a new blank tab lands in the address bar with its text selected, the command
 * palette can aim focus at either surface, and Cmd/Ctrl+L reaches the bar from anywhere.
 * It also carries the history shortcut, so every pane kind opens the history view the same way.
 */
export function useBrowserPageChromeFocus({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  addressBarInputRef,
  guestFocus
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  addressBarInputRef: RefObject<HTMLInputElement | null>
  guestFocus: BrowserPageGuestFocus
}): {
  focusAddressBarNow: (selection?: BrowserAddressBarSelection) => boolean
  focusGuestNow: () => boolean
  /**
   * Takes the address bar and holds it against whatever re-grabs focus a frame later. Pass a
   * selection to resume an edit already in progress instead of selecting the bar's whole text.
   */
  startAddressBarFocusGrab: (selection?: BrowserAddressBarSelection) => () => void
  /** Set while a focus grab is in flight, so panes don't hand focus back to the guest mid-retry. */
  keepAddressBarFocusRef: MutableRefObject<boolean>
} {
  useBrowserHistoryShortcut({ browserTabId, workspaceId, isActive, chromeShortcutScope })
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)
  const keybindings = useAppStore((s) => s.keybindings)
  const keepAddressBarFocusRef = useRef(false)
  const addressBarFocusGrabRef = useRef<(() => void) | null>(null)
  // Why a layout effect: it lands before the previous render's passive cleanups read it.
  const isActiveRef = useRef(isActive)
  useLayoutEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  const cancelAddressBarFocusGrab = useCallback((): void => {
    addressBarFocusGrabRef.current?.()
  }, [])

  const focusAddressBarNow = useCallback(
    (selection?: BrowserAddressBarSelection) => {
      const input = addressBarInputRef.current
      if (!input) {
        return false
      }
      guestFocus.blur()
      input.focus()
      if (selection) {
        // Why: focusing the bar fires its own select-on-focus, which would throw away the caret a
        // resumed edit is being restored to — so put it back after the focus event has run.
        input.setSelectionRange(selection.start, selection.end, selection.direction)
      } else {
        input.select()
      }
      return document.activeElement === input
    },
    [addressBarInputRef, guestFocus]
  )

  const focusGuestNow = useCallback(() => {
    // Why: blurring for a guest that isn't there strands focus on document.body, where no
    // shortcut lands; leave it wherever it already is instead.
    if (!guestFocus.isAttached()) {
      return false
    }
    addressBarInputRef.current?.blur()
    return guestFocus.focus()
  }, [addressBarInputRef, guestFocus])

  /**
   * Takes the address bar and holds it for a few frames, because whatever activated the pane
   * re-grabs focus a frame later. Returns a canceller, which is also parked in a ref so call sites
   * with nowhere to keep it still get cancelled when the pane goes inactive — the remaining frames
   * would otherwise pull focus into a pane the user has already switched away from. The latch it
   * raises is cleared when the grab ends either way: only the local pane has load handlers that
   * would otherwise clear it, so a latch left standing locks the rest out of their own page.
   */
  const startAddressBarFocusGrab = useCallback(
    (selection?: BrowserAddressBarSelection): (() => void) => {
      cancelAddressBarFocusGrab()
      let cancelled = false
      let frameId = 0
      let attempts = 0
      const cancel = (): void => {
        // Why: unguarded, a stale canceller clears the ref out from under whichever grab is live
        // now, and the cleanup meant to cancel that one then finds nothing left to call.
        if (addressBarFocusGrabRef.current !== cancel) {
          return
        }
        addressBarFocusGrabRef.current = null
        cancelled = true
        window.cancelAnimationFrame(frameId)
        keepAddressBarFocusRef.current = false
      }
      const focusAddressBar = (): void => {
        if (cancelled) {
          return
        }
        // Why later frames skip a bar that is already ours: the retries exist to fight the guest
        // taking focus back, and re-running the whole take on a bar nobody stole drags the caret
        // off whatever the user has typed since — for the ~100ms the frames span.
        if (attempts === 0 || document.activeElement !== addressBarInputRef.current) {
          focusAddressBarNow(selection)
        }
        attempts += 1
        if (attempts < ADDRESS_BAR_FOCUS_FRAMES) {
          frameId = window.requestAnimationFrame(focusAddressBar)
        } else {
          addressBarFocusGrabRef.current = null
          keepAddressBarFocusRef.current = false
        }
      }
      addressBarFocusGrabRef.current = cancel
      keepAddressBarFocusRef.current = true
      // Why the first attempt is not deferred to a frame: callers that follow a grab with work
      // keyed off the bar actually holding focus — the URL-follow guards do — run before any frame
      // callback, and would read the bar as idle and overwrite the edit the grab is protecting.
      focusAddressBar()
      return cancel
    },
    [addressBarInputRef, cancelAddressBarFocusGrab, focusAddressBarNow]
  )

  useEffect(() => {
    if (!isActive) {
      return
    }
    // Why: one-shot, so revisiting the tab later doesn't steal focus from the page again.
    if (!consumeAddressBarFocusRequest(browserTabId)) {
      return
    }
    return startAddressBarFocusGrab()
  }, [browserTabId, consumeAddressBarFocusRequest, isActive, startAddressBarFocusGrab])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFocusBrowserAddressBar(({ browserPageId }) => {
      if (browserPageId === browserTabId) {
        focusAddressBarNow()
      }
    })
  }, [browserTabId, focusAddressBarNow, isActive])

  // Why: the IPC above only fires while the page itself holds focus; from chrome the chord
  // never leaves the renderer, and capture beats the workspace or an embedded editor to it.
  useEffect(() => {
    if (chromeShortcutScope === 'inactive') {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        !keybindingMatchesAction('browser.focusAddressBar', event, shortcutPlatform, keybindings)
      ) {
        return
      }
      if (!browserChromeShortcutOwnsEvent(chromeShortcutScope, event, workspaceId)) {
        return
      }
      event.preventDefault()
      // Why: every mounted pane registers this same capture listener on window, and
      // stopPropagation would still let each of them grab focus in turn.
      event.stopImmediatePropagation()
      focusAddressBarNow()
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [chromeShortcutScope, focusAddressBarNow, keybindings, workspaceId])

  /**
   * Focuses the page, waiting for a new tab's guest to attach first. Returns a canceller that
   * requeues an unfinished request unless `{ requeue: false }`, so a re-run still finds it.
   */
  const startGuestFocusRetry = useCallback(
    ({ firstAttempt }: { firstAttempt: 'now' | 'next-frame' }) => {
      let cancelled = false
      let settled = false
      let frameId = 0
      let attempts = 0
      let waitedFrames = 0
      const focusAtRequest = document.activeElement
      const runFocus = (): void => {
        if (cancelled) {
          return
        }
        // Why: the retry budget starts once there is a guest; focus the user moves meanwhile
        // stays where they put it.
        if (attempts === 0) {
          const active = document.activeElement
          if (active !== focusAtRequest && active !== document.body) {
            settled = true
            return
          }
          if (!guestFocus.isAttached() && waitedFrames < GUEST_ATTACH_WAIT_FRAMES) {
            waitedFrames += 1
            frameId = window.requestAnimationFrame(runFocus)
            return
          }
        }
        attempts += 1
        settled = focusGuestNow()
        if (!settled && attempts < ADDRESS_BAR_FOCUS_FRAMES) {
          frameId = window.requestAnimationFrame(runFocus)
        }
      }
      if (firstAttempt === 'now') {
        runFocus()
      } else {
        frameId = window.requestAnimationFrame(runFocus)
      }
      return ({ requeue = true }: { requeue?: boolean } = {}): void => {
        cancelled = true
        window.cancelAnimationFrame(frameId)
        // Why: a re-run (StrictMode, a dependency change) mid-wait must still find the request; a
        // pane the user left drops it, so coming back later doesn't pull focus into the page.
        if (requeue && !settled && waitedFrames < GUEST_ATTACH_WAIT_FRAMES && isActiveRef.current) {
          queueBrowserFocusRequest({ pageId: browserTabId, target: 'webview' })
        }
      }
    },
    [browserTabId, focusGuestNow, guestFocus]
  )

  useEffect(() => {
    if (!isActive) {
      return
    }
    const focusTarget = consumeBrowserFocusRequest(browserTabId)
    if (!focusTarget) {
      return
    }
    if (focusTarget === 'address-bar') {
      return startAddressBarFocusGrab()
    }
    // Why: lowering the latch is not enough — a grab already in flight would spend its remaining
    // frames dragging focus back off the page this request just aimed at.
    cancelAddressBarFocusGrab()
    // Why a frame first: focus can be queued before the pane mounts and is claimed here.
    return startGuestFocusRetry({ firstAttempt: 'next-frame' })
  }, [
    browserTabId,
    cancelAddressBarFocusGrab,
    isActive,
    startAddressBarFocusGrab,
    startGuestFocusRetry
  ])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const handleBrowserFocusRequest = (event: Event): void => {
      const detail = (event as CustomEvent<BrowserFocusRequestDetail>).detail
      if (!detail || detail.pageId !== browserTabId) {
        return
      }
      const focusTarget = consumeBrowserFocusRequest(browserTabId)
      if (!focusTarget) {
        return
      }
      if (focusTarget === 'address-bar') {
        // Why: palette-triggered focus fights the same re-grab as a new tab does, so it takes
        // the bar the same bounded way rather than latching on a single try.
        startAddressBarFocusGrab()
        return
      }
      cancelAddressBarFocusGrab()
      cancelGuestFocus?.({ requeue: false })
      // Why the same retry as on mount: a remote link's request can land after the pane mounted
      // but before its guest attached.
      cancelGuestFocus = startGuestFocusRetry({ firstAttempt: 'now' })
    }
    let cancelGuestFocus: ReturnType<typeof startGuestFocusRetry> | null = null
    // Why: an already-active page never remounts, so listen for the event to consume the durable focus request immediately.
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
    return () => {
      window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
      cancelAddressBarFocusGrab()
      cancelGuestFocus?.()
    }
  }, [
    browserTabId,
    cancelAddressBarFocusGrab,
    isActive,
    startAddressBarFocusGrab,
    startGuestFocusRetry
  ])

  return { focusAddressBarNow, focusGuestNow, startAddressBarFocusGrab, keepAddressBarFocusRef }
}
