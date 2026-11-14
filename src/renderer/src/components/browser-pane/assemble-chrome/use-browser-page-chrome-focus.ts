import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject
} from 'react'
import { useAppStore } from '@/store'
import {
  consumeBrowserFocusRequest,
  queueBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from '../host-guest/browser-focus'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import type { BrowserAddressBarSelection } from './browser-address-bar-edit-session'
import type { BrowserPageGuestFocus } from './browser-page-guest-focus'
import { useBrowserHistoryShortcut } from '../history/use-browser-history-shortcut'
import { useBrowserAddressBarShortcut } from './use-browser-address-bar-shortcut'
import { useWebviewDragPassthroughActive } from '../host-guest/use-webview-drag-passthrough-active'

/** Frames an address-bar grab keeps retrying before it lets the guest have focus back. */
const ADDRESS_BAR_FOCUS_FRAMES = 6
/** Frames a queued page-focus request waits for a new tab's guest to attach. */
const GUEST_ATTACH_WAIT_FRAMES = 120

/** Share chrome/page focus ownership, blank-tab grabs and platform chords across local, client-hosted and streamed panes. */
export function useBrowserPageChromeFocus({
  browserTabId,
  workspaceId,
  isActive,
  chromeShortcutScope,
  addressBarInputRef,
  guestFocus,
  inputLocked = false
}: {
  browserTabId: string
  workspaceId: string
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  addressBarInputRef: RefObject<HTMLInputElement | null>
  guestFocus: BrowserPageGuestFocus
  /** A phone is driving the page; the desktop keyboard must not reach it. */
  inputLocked?: boolean
}): {
  focusAddressBarNow: (selection?: BrowserAddressBarSelection) => boolean
  focusGuestNow: () => boolean
  /** Retry against delayed focus theft; a supplied selection resumes an edit instead of selecting all. */
  startAddressBarFocusGrab: (selection?: BrowserAddressBarSelection) => () => void
  /** Set while a focus grab is in flight, so panes don't hand focus back to the guest mid-retry. */
  keepAddressBarFocusRef: MutableRefObject<boolean>
} {
  useBrowserHistoryShortcut({ browserTabId, workspaceId, isActive, chromeShortcutScope })
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)
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
        // Restore the resumed caret after focus handlers finish their select-all.
        input.setSelectionRange(selection.start, selection.end, selection.direction)
      } else {
        input.select()
      }
      return document.activeElement === input
    },
    [addressBarInputRef, guestFocus]
  )

  const focusGuestNow = useCallback(() => {
    // Do not blur without an attached guest; body focus would strand shortcuts.
    if (!guestFocus.isAttached()) {
      return false
    }
    addressBarInputRef.current?.blur()
    return guestFocus.focus()
  }, [addressBarInputRef, guestFocus])

  /** Hold the bar against delayed focus theft; retain a canceller for deactivation and clear the latch on every ending, including panes without local load handlers. */
  const startAddressBarFocusGrab = useCallback(
    (selection?: BrowserAddressBarSelection): (() => void) => {
      cancelAddressBarFocusGrab()
      let cancelled = false
      let frameId = 0
      let attempts = 0
      const cancel = (): void => {
        // A stale canceller must not clear the live grab’s ref and leave it unreachable by cleanup.
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
        // Retry only after focus theft; retaking an already-focused bar would reset the caret over new typing.
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
      // Take focus synchronously so immediate URL-follow guards see the edit as active before writing guest state.
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

  useBrowserAddressBarShortcut({ workspaceId, chromeShortcutScope, focusAddressBarNow })

  /** Wait for guest attachment; cancellation requeues unfinished active requests unless explicitly disabled. */
  const startGuestFocusRetry = useCallback(
    ({
      firstAttempt,
      stillWanted = () => true,
      focusAtRequest = document.activeElement
    }: {
      firstAttempt: 'now' | 'next-frame'
      /** Checked before every attempt; false drops the focus for good. */
      stillWanted?: () => boolean
      /** Focus the request began from; moving off it before the first attempt yields to the user. */
      focusAtRequest?: Element | null
    }) => {
      let cancelled = false
      let settled = false
      let frameId = 0
      let attempts = 0
      let waitedFrames = 0
      const runFocus = (): void => {
        if (cancelled) {
          return
        }
        if (!stillWanted()) {
          settled = true
          return
        }
        // Before a guest arrives, preserve any focus change the user makes rather than spending the retry budget.
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
      // Returns whether the retry got to act: tried focus, or settled without it.
      return ({ requeue = true }: { requeue?: boolean } = {}): boolean => {
        cancelled = true
        window.cancelAnimationFrame(frameId)
        // Requeue active StrictMode/dependency retries, but drop departed panes so revisiting cannot steal focus.
        if (requeue && !settled && waitedFrames < GUEST_ATTACH_WAIT_FRAMES && isActiveRef.current) {
          queueBrowserFocusRequest({ pageId: browserTabId, target: 'webview' })
        }
        return settled || attempts > 0
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
    // Cancel the bar grab as well as its latch or remaining frames will steal page focus back.
    cancelAddressBarFocusGrab()
    // Why a frame first: focus can be queued before the pane mounts and is claimed here.
    const cancelGuestFocus = startGuestFocusRetry({ firstAttempt: 'next-frame' })
    return () => void cancelGuestFocus()
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
        // Palette requests need the same bounded retry against delayed focus theft as blank tabs.
        startAddressBarFocusGrab()
        return
      }
      cancelAddressBarFocusGrab()
      cancelGuestFocus?.({ requeue: false })
      // Remote requests can arrive after mounting but before guest attachment; use the same wait path.
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

  // Why an effect event: a split focused mid-retry must not re-run the effect and cancel it.
  const isSplitFocused = useEffectEvent(
    () => chromeShortcutScope === 'focused' || chromeShortcutScope === 'owned-target-focused'
  )
  const dragPassthroughActive = useWebviewDragPassthroughActive(isActive)
  const focusedForActivationRef = useRef(false)
  // Why: a restarted activation keeps the focus it began from, so a user choice made before the restart still wins.
  const activationFocusAtRequestRef = useRef<{ element: Element | null } | null>(null)
  // Why: switching to a page hands it the keyboard, as for terminals (#20533); declared after the
  // address-bar effects so a new blank tab's grab has already raised the latch.
  useEffect(() => {
    if (!isActive) {
      focusedForActivationRef.current = false
      activationFocusAtRequestRef.current = null
      return
    }
    // Why before the drag guard: a page activated mid-drag still yields to focus the user picks during it.
    if (activationFocusAtRequestRef.current === null) {
      activationFocusAtRequestRef.current = { element: document.activeElement }
    }
    // Why defer, not consume: focusing a guest mid-drag reads as an aborted drag.
    if (focusedForActivationRef.current || dragPassthroughActive) {
      return
    }
    focusedForActivationRef.current = true
    // Why the focused split only: never pull the keyboard across splits.
    const cancelGuestFocus = startGuestFocusRetry({
      firstAttempt: 'now',
      focusAtRequest: activationFocusAtRequestRef.current.element,
      stillWanted: () => !inputLocked && isSplitFocused() && !keepAddressBarFocusRef.current
    })
    return () => {
      // Why: no requeue, since leaving the tab drops an activation; but a re-run that cancels it while waiting for the guest to attach (StrictMode remount as Settings closes) must retry.
      if (!cancelGuestFocus({ requeue: false })) {
        focusedForActivationRef.current = false
      }
    }
  }, [dragPassthroughActive, inputLocked, isActive, startGuestFocusRetry])

  return { focusAddressBarNow, focusGuestNow, startAddressBarFocusGrab, keepAddressBarFocusRef }
}
