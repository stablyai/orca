import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { scheduleNextFrame } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Frames a reveal keeps re-taking the composer before it gives up (~100ms). */
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
    let attempts = 0
    const claim = (): void => {
      if (cancelled) {
        return
      }
      const active = rootRef.current?.ownerDocument.activeElement ?? null
      // Focus already inside this pane is our own take landing or the user's click; either ends it.
      if (rootRef.current?.contains(active) === true) {
        claimedRef.current = true
        return
      }
      // Why: a live text field elsewhere is a user edit — a batch worktree-create keeps its
      // next name field open behind the pane we just revealed.
      if (shouldPreserveEditableFocus(active)) {
        claimedRef.current = true
        return
      }
      composerRef.current?.focus()
      attempts += 1
      if (attempts < REVEAL_FOCUS_FRAMES) {
        scheduleFrame(claim)
        return
      }
      claimedRef.current = true
    }
    // Why: Radix restores the dialog trigger in a setTimeout(0) on close, which beats a
    // same-tick take; a frame lands after it.
    scheduleFrame(claim)
    return () => {
      cancelled = true
    }
  }, [composerReady, composerRef, revealed, rootRef, scheduleFrame])
}
