import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { scheduleNextFrame } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Focus attempts per reveal, including recovery from delayed programmatic restoration. */
const REVEAL_FOCUS_FRAMES = 6

type NativeChatComposerRevealFocusArgs = {
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
  rootRef,
  composerRef,
  isVisible,
  isFocusedGroup,
  composerReady,
  scheduleFrame = scheduleNextFrame
}: NativeChatComposerRevealFocusArgs): void {
  const revealed = isVisible && isFocusedGroup
  const claimedRef = useRef(false)

  useEffect(() => {
    if (!revealed) {
      claimedRef.current = false
      return
    }
    if (claimedRef.current || !composerReady) {
      return
    }
    let cancelled = false
    let userInteracted = false
    let attempts = 0
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
      stopWatchingUserIntent()
    }
    ownerDocument?.addEventListener('pointerdown', cancelForPointer, true)
    ownerDocument?.addEventListener('keydown', cancelForFocusNavigation, true)
    const claim = (): void => {
      if (cancelled) {
        return
      }
      if (userInteracted) {
        finish()
        return
      }
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      // Focus already inside this pane is our own take landing or the user's click; either ends it.
      if (rootRef.current?.contains(active) === true) {
        finish()
        return
      }
      // Why: a live text field elsewhere is a user edit — a batch worktree-create keeps its
      // next name field open behind the pane we just revealed.
      if (shouldPreserveEditableFocus(active)) {
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
  }, [composerReady, composerRef, revealed, rootRef, scheduleFrame])
}
