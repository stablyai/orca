import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { scheduleNextFrame } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Focus attempts per reveal, including recovery from delayed programmatic restoration. */
const REVEAL_FOCUS_FRAMES = 6
const PENDING_FOCUS_MS = 1000

const revealedComposerReclaims = new Map<string, (onlyIfFocusUnclaimed?: boolean) => void>()
const mountedComposers = new Set<RefObject<NativeChatComposerHandle | null>>()
let pendingFocusRequest: { tabId: string | null; cancel: () => void } | null = null
let focusRequestGeneration = 0

export type NativeChatComposerFocusIntent = {
  request: (tabId: string) => void
  cancel: () => void
}

/** Keep a new-chat action's focus intent through destination claim, navigation, or expiry. */
export function captureNativeChatComposerFocusIntent(): NativeChatComposerFocusIntent {
  focusRequestGeneration += 1
  pendingFocusRequest?.cancel()
  if (typeof document === 'undefined') {
    return { request: () => undefined, cancel: () => undefined }
  }
  const cancel = (): void => {
    if (pendingFocusRequest !== pending) {
      return
    }
    pendingFocusRequest = null
    clearTimeout(timeout)
    document.removeEventListener('pointerdown', cancel, true)
    document.removeEventListener('keydown', cancelForNavigation, true)
  }
  const cancelForNavigation = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      cancel()
    }
  }
  const pending: { tabId: string | null; cancel: () => void } = { tabId: null, cancel }
  const timeout = setTimeout(cancel, PENDING_FOCUS_MS)
  pendingFocusRequest = pending
  document.addEventListener('pointerdown', cancel, true)
  document.addEventListener('keydown', cancelForNavigation, true)
  return {
    request: (tabId) => {
      if (pendingFocusRequest !== pending) {
        return
      }
      pending.tabId = tabId
      const reclaim = revealedComposerReclaims.get(tabId)
      if (reclaim) {
        cancel()
        reclaim()
      }
    },
    cancel
  }
}

/** Re-clicking a chat's active tab claims its composer again, as a terminal tab refocuses xterm. */
export function requestNativeChatComposerFocus(
  tabId: string,
  options: { onlyIfFocusUnclaimed?: boolean } = {}
): void {
  if (options.onlyIfFocusUnclaimed) {
    // A rename return is one-shot, not an activation to replay after a hidden composer reveals.
    revealedComposerReclaims.get(tabId)?.(true)
    return
  }
  captureNativeChatComposerFocusIntent().request(tabId)
}

export type NativeChatComposerRevealFocusArgs = {
  /** The tab whose activation re-runs the claim (the terminal tab for a chat view over a TUI). */
  tabId: string
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  isVisible: boolean
  /** This pane's split group is the focused one; false keeps a revealed sibling from fighting. */
  isFocusedGroup: boolean
  /** A composer is mounted and enabled — false while a prompt/question card owns the region. */
  composerReady: boolean
  /** Override the frame scheduler (tests). */
  scheduleFrame?: (callback: () => void) => void
}

/**
 * Focus the composer whenever this pane reveals it, so a chat you just opened —
 * or switched back to — is ready to type into. Retained panes never unmount, so
 * the reveal edge, not mount, is the signal.
 */
export function useNativeChatComposerRevealFocus({
  tabId,
  rootRef,
  composerRef,
  isVisible,
  isFocusedGroup,
  composerReady,
  scheduleFrame = scheduleNextFrame
}: NativeChatComposerRevealFocusArgs): void {
  const revealed = isVisible && isFocusedGroup
  const claimedRef = useRef(false)
  // An explicit tab activation takes focus from inside the pane too, short of a text field.
  const explicitRef = useRef(false)
  const [reclaimCount, setReclaimCount] = useState(0)

  useLayoutEffect(() => {
    mountedComposers.add(composerRef)
    return () => {
      mountedComposers.delete(composerRef)
    }
  }, [composerRef])

  useLayoutEffect(() => {
    if (!revealed || !composerReady) {
      return
    }
    const reclaim = (onlyIfFocusUnclaimed = false): void => {
      if (onlyIfFocusUnclaimed) {
        const root = rootRef.current
        const active = root?.ownerDocument.activeElement
        if (root && (active === null || active === root.ownerDocument.body)) {
          composerRef.current?.focus()
        }
        return
      }
      claimedRef.current = false
      explicitRef.current = true
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      const siblingComposer = [...mountedComposers].some(
        (ownerRef) => ownerRef !== composerRef && ownerRef.current?.contains(active)
      )
      if (
        (!shouldPreserveEditableFocus(active) || siblingComposer) &&
        composerRef.current?.focus()
      ) {
        explicitRef.current = false
      }
      setReclaimCount((count) => count + 1)
    }
    revealedComposerReclaims.set(tabId, reclaim)
    if (pendingFocusRequest?.tabId === tabId) {
      pendingFocusRequest.cancel()
      reclaim()
    }
    return () => {
      if (revealedComposerReclaims.get(tabId) === reclaim) {
        revealedComposerReclaims.delete(tabId)
      }
    }
  }, [composerReady, composerRef, revealed, rootRef, tabId])

  useEffect(() => {
    if (!revealed || !composerReady) {
      claimedRef.current = false
      explicitRef.current = false
      return
    }
    if (claimedRef.current) {
      return
    }
    let cancelled = false
    let userInteracted = false
    let attempts = 0
    const requestGeneration = focusRequestGeneration
    const ownerDocument = rootRef.current?.ownerDocument
    const cancelForPointer = (): void => {
      userInteracted = true
    }
    const cancelForFocusNavigation = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        userInteracted = true
      }
    }
    const stopWatchingUserIntent = (): void => {
      ownerDocument?.removeEventListener('pointerdown', cancelForPointer, true)
      ownerDocument?.removeEventListener('keydown', cancelForFocusNavigation, true)
    }
    const finish = (): void => {
      claimedRef.current = true
      explicitRef.current = false
      stopWatchingUserIntent()
    }
    ownerDocument?.addEventListener('pointerdown', cancelForPointer, true)
    ownerDocument?.addEventListener('keydown', cancelForFocusNavigation, true)
    const claim = (): void => {
      if (cancelled) {
        return
      }
      if (requestGeneration !== focusRequestGeneration) {
        stopWatchingUserIntent()
        return
      }
      if (userInteracted) {
        finish()
        return
      }
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      // Focus already inside this pane is our own take landing or the user's click; either ends it.
      // A just-collapsed card is hidden and inert, so focus left in it is about to drop to body.
      if (
        !explicitRef.current &&
        rootRef.current?.contains(active) === true &&
        !active?.closest('[hidden], [inert]')
      ) {
        finish()
        return
      }
      // Why: a live text field is a user edit — a batch worktree-create keeps its next name
      // field open behind the pane we just revealed, and the find bar keeps its query.
      const editingSiblingComposer =
        explicitRef.current &&
        rootRef.current?.contains(active) !== true &&
        [...mountedComposers].some((ownerRef) => ownerRef.current?.contains(active))
      if (shouldPreserveEditableFocus(active) && !editingSiblingComposer) {
        finish()
        return
      }
      composerRef.current?.focus()
      attempts += 1
      if (attempts < REVEAL_FOCUS_FRAMES) {
        scheduleFrame(claim)
        return
      }
      finish()
    }
    // Why: Radix restores the dialog trigger in a setTimeout(0) on close, which beats a
    // same-tick take; a frame lands after it.
    scheduleFrame(claim)
    return () => {
      cancelled = true
      stopWatchingUserIntent()
    }
  }, [composerReady, composerRef, reclaimCount, revealed, rootRef, scheduleFrame])
}
