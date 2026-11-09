import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

import { shouldPreserveEditableFocus } from '@/lib/editable-focus-preservation'
import { scheduleNextFrame } from '@/components/terminal-pane/input/ime/terminal-ime-input-context-refresh'
import { getOverlayFocusOwners } from '@/lib/overlay-focus-ownership'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import { registerNativeChatPane } from './native-chat-composer-mount'
import {
  getNativeChatComposerFocusRequestGeneration,
  registerNativeChatComposerReclaim
} from './native-chat-composer-focus-intent'

/** Focus attempts per reveal, including recovery from delayed programmatic restoration. */
const REVEAL_FOCUS_FRAMES = 6
const mountedComposers = new Set<RefObject<NativeChatComposerHandle | null>>()

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
  /** A mounted prompt, install card, or final error can receive the handoff without an editor. */
  surfaceReady?: boolean
  scheduleFrame?: (callback: () => void) => void
}

/** Retained panes do not remount; claim focus on reveal edges instead. */
export function useNativeChatComposerRevealFocus({
  tabId,
  rootRef,
  composerRef,
  isVisible,
  isFocusedGroup,
  composerReady,
  surfaceReady = false,
  scheduleFrame = scheduleNextFrame
}: NativeChatComposerRevealFocusArgs): void {
  const revealed = isVisible && isFocusedGroup
  useLayoutEffect(() => {
    if (composerReady || surfaceReady) {
      return registerNativeChatPane(
        tabId,
        () => surfaceReady || composerRef.current?.acceptsText() === true
      )
    }
    return undefined
  }, [composerReady, composerRef, surfaceReady, tabId])
  const claimedRef = useRef(false)
  // An explicit tab activation takes focus from inside the pane too, short of a text field.
  const explicitRef = useRef(false)
  const sourceOverlaysRef = useRef<readonly HTMLElement[]>([])
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
    const reclaim = (
      onlyIfFocusUnclaimed = false,
      sourceOverlays: readonly HTMLElement[] = []
    ): void => {
      if (getOverlayFocusOwners(rootRef.current ?? undefined).length > 0) {
        claimedRef.current = true
        explicitRef.current = false
        setReclaimCount((count) => count + 1)
        return
      }
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
      sourceOverlaysRef.current = sourceOverlays
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      const siblingComposer = [...mountedComposers].some(
        (ownerRef) => ownerRef !== composerRef && ownerRef.current?.contains(active)
      )
      if (
        (!shouldPreserveEditableFocus(active) ||
          siblingComposer ||
          sourceOverlays.some((overlay) => overlay.contains(active))) &&
        composerRef.current?.focus()
      ) {
        explicitRef.current = false
      }
      setReclaimCount((count) => count + 1)
    }
    return registerNativeChatComposerReclaim(tabId, reclaim, rootRef.current)
  }, [composerReady, composerRef, revealed, rootRef, tabId])

  useEffect(() => {
    if (!revealed || !composerReady) {
      claimedRef.current = false
      explicitRef.current = false
      sourceOverlaysRef.current = []
      return
    }
    if (claimedRef.current) {
      return
    }
    let cancelled = false
    let userInteracted = false
    let attempts = 0
    const requestGeneration = getNativeChatComposerFocusRequestGeneration()
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
      sourceOverlaysRef.current = []
      stopWatchingUserIntent()
    }
    ownerDocument?.addEventListener('pointerdown', cancelForPointer, true)
    ownerDocument?.addEventListener('keydown', cancelForFocusNavigation, true)
    const claim = (): void => {
      if (cancelled) {
        return
      }
      if (requestGeneration !== getNativeChatComposerFocusRequestGeneration()) {
        stopWatchingUserIntent()
        return
      }
      if (userInteracted || getOverlayFocusOwners(rootRef.current ?? undefined).length > 0) {
        finish()
        return
      }
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      // Inside focus ends the claim unless a hidden/inert collapsed card is about to lose it.
      if (
        !explicitRef.current &&
        rootRef.current?.contains(active) === true &&
        !active?.closest('[hidden], [inert]')
      ) {
        finish()
        return
      }
      // Preserve live text edits such as the next workspace name or find query behind the revealed pane.
      const editingSiblingComposer =
        explicitRef.current &&
        rootRef.current?.contains(active) !== true &&
        [...mountedComposers].some((ownerRef) => ownerRef.current?.contains(active))
      const editingSourceOverlay =
        explicitRef.current && sourceOverlaysRef.current.some((overlay) => overlay.contains(active))
      if (shouldPreserveEditableFocus(active) && !editingSiblingComposer && !editingSourceOverlay) {
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
    // Claim on a frame after Radix’s setTimeout(0) trigger restoration, which beats same-tick focus.
    scheduleFrame(claim)
    return () => {
      cancelled = true
      stopWatchingUserIntent()
    }
  }, [composerReady, composerRef, reclaimCount, revealed, rootRef, scheduleFrame])
}
