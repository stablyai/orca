import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import {
  consumeBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from '../host-guest/browser-focus'
import { browserOverlayOwnsShortcutTarget } from '../describe-page/browser-overlay-shortcut-target'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import type { BrowserAddressBarSelection } from './browser-address-bar-edit-session'
import type { BrowserPageGuestFocus } from './browser-page-guest-focus'

/** Frames an address-bar grab keeps retrying before it lets the guest have focus back. */
const ADDRESS_BAR_FOCUS_FRAMES = 6

/**
 * Who owns focus in a browser pane's chrome. Every pane — local, client-hosted and streamed —
 * uses this so a new blank tab lands in the address bar with its text selected, the command
 * palette can aim focus at either surface, and Cmd/Ctrl+L reaches the bar from anywhere.
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
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)
  const keybindings = useAppStore((s) => s.keybindings)
  const keepAddressBarFocusRef = useRef(false)
  const addressBarFocusGrabRef = useRef<(() => void) | null>(null)

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
    return window.api.ui.onFocusBrowserAddressBar(() => {
      focusAddressBarNow()
    })
  }, [focusAddressBarNow, isActive])

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
      if (
        chromeShortcutScope === 'owned-target' &&
        !browserOverlayOwnsShortcutTarget(event.target, workspaceId)
      ) {
        return
      }
      event.preventDefault()
      // Why: every mounted pane registers this same capture listener on window, and
      // stopPropagation would still let each of them grab focus in turn.
      event.stopImmediatePropagation()
      focusAddressBarNow()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [chromeShortcutScope, focusAddressBarNow, keybindings, workspaceId])

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
    let cancelled = false
    let frameId = 0
    let attempts = 0
    const runFocus = (): void => {
      if (cancelled) {
        return
      }
      attempts += 1
      if (!focusGuestNow() && attempts < ADDRESS_BAR_FOCUS_FRAMES) {
        frameId = window.requestAnimationFrame(runFocus)
      }
    }
    // Why: focus can be queued before the pane mounts; persisting outside React lets it be claimed on mount instead of racing an event.
    frameId = window.requestAnimationFrame(runFocus)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [browserTabId, cancelAddressBarFocusGrab, focusGuestNow, isActive, startAddressBarFocusGrab])

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
      focusGuestNow()
    }
    // Why: an already-active page never remounts, so listen for the event to consume the durable focus request immediately.
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
    return () => {
      window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
      cancelAddressBarFocusGrab()
    }
  }, [browserTabId, cancelAddressBarFocusGrab, focusGuestNow, isActive, startAddressBarFocusGrab])

  return { focusAddressBarNow, focusGuestNow, startAddressBarFocusGrab, keepAddressBarFocusRef }
}
