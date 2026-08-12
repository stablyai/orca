import type { MutableRefObject } from 'react'
import { shouldCancelVirtualizedScrollOffsetRestore } from './virtualizedScrollOffsetRestore'
import type { ProgrammaticScrollMarks } from './programmatic-scroll-marks'

type CreateVirtualizedScrollAnchorListenerArgs<TScrollElement extends Element> = {
  el: TScrollElement
  getHasDirectScrollInput: () => (() => boolean) | undefined
  getMarks: () => ProgrammaticScrollMarks | undefined
  getRecordAnchorOnScroll: () => boolean
  // Why: our own writes (virtualizer size adjustments, restore nudges) move
  // the viewport; the owner must sync its bookkeeping (scrollOffset, anchor
  // scrollTop) or a later divergence check reads the moved offset as user
  // input and drops a due restore.
  onProgrammaticScroll: (scrollTop: number) => void
  pendingRestoreRef: MutableRefObject<boolean>
  recordCurrentAnchor: () => void
  recordUserScroll: (scrollTop: number) => void
  targetOffset: number
  scrollOffsetRef: MutableRefObject<number>
}

/**
 * Owns the mount-time offset restore and classifies subsequent scroll events.
 * With marks, classification is state-owned: a scroll is the user's exactly
 * when no registered programmatic write (or its clamped landing) explains it.
 * Without marks, falls back to the legacy direct-input time window.
 * Writes the initial offset on creation when one is persisted.
 */
export function createVirtualizedScrollAnchorListener<TScrollElement extends Element>({
  el,
  getHasDirectScrollInput,
  getMarks,
  getRecordAnchorOnScroll,
  onProgrammaticScroll,
  pendingRestoreRef,
  recordCurrentAnchor,
  recordUserScroll,
  targetOffset,
  scrollOffsetRef
}: CreateVirtualizedScrollAnchorListenerArgs<TScrollElement>): (event: Event) => void {
  // Why: a write to the current position emits no scroll event, so an armed
  // restore would never complete and would snap later marked writes back to
  // this stale target. Nothing to restore — don't arm.
  let restoring = targetOffset > 0 && el.scrollTop !== targetOffset
  if (restoring) {
    getMarks()?.mark(targetOffset)
    el.scrollTop = targetOffset
  }

  const completeRestore = (): void => {
    restoring = false
    if (getRecordAnchorOnScroll()) {
      recordCurrentAnchor()
    } else {
      scrollOffsetRef.current = el.scrollTop
    }
  }

  return (event: Event): void => {
    const marks = getMarks()
    if (marks) {
      const isProgrammatic = marks.consume(event, el.scrollTop, el.scrollHeight - el.clientHeight)
      if (restoring) {
        if (el.scrollTop === targetOffset) {
          completeRestore()
          return
        }
        if (!isProgrammatic) {
          const maxScrollOffset = el.scrollHeight - el.clientHeight
          // Why: an unmarked landing pinned at a max the target can't reach
          // is the browser clamping after content shrank, not user input;
          // keep waiting for the range to catch up instead of persisting the
          // clamped position. Direct input still takes over immediately.
          const clampExplainsLanding =
            targetOffset > maxScrollOffset && el.scrollTop >= maxScrollOffset - 2
          if (!clampExplainsLanding || getHasDirectScrollInput()?.() === true) {
            // Why: an unmarked scroll no clamp explains is the user taking
            // control of the viewport (marks classify our writes and their
            // clamped landings); their position wins over the persisted offset.
            restoring = false
            pendingRestoreRef.current = false
            recordCurrentAnchor()
            return
          }
        }
        if (el.scrollHeight - el.clientHeight >= targetOffset) {
          marks.mark(targetOffset)
          el.scrollTop = targetOffset
          if (el.scrollTop === targetOffset) {
            completeRestore()
          }
        }
        return
      }
      if (isProgrammatic) {
        onProgrammaticScroll(el.scrollTop)
        return
      }
      pendingRestoreRef.current = false
      if (!getRecordAnchorOnScroll()) {
        return
      }
      recordUserScroll(el.scrollTop)
      return
    }
    if (
      shouldCancelVirtualizedScrollOffsetRestore({
        hasDirectScrollInput: getHasDirectScrollInput(),
        restoring
      })
    ) {
      // Why: direct wheel/touch input means the user has taken control of the
      // viewport. Treat the current offset as intentional instead of snapping
      // back to a stale persisted offset while restoration is still pending.
      restoring = false
      recordCurrentAnchor()
      return
    }
    if (restoring) {
      // Why: during a fresh virtualizer mount, total height may still be
      // estimate-based. Avoid persisting a browser-clamped offset as the
      // user's real position until the intended offset is reachable.
      if (el.scrollTop === targetOffset) {
        completeRestore()
        return
      }
      if (el.scrollHeight - el.clientHeight >= targetOffset) {
        el.scrollTop = targetOffset
        if (el.scrollTop === targetOffset) {
          completeRestore()
        }
      }
      return
    }
    if (!getRecordAnchorOnScroll()) {
      return
    }
    recordUserScroll(el.scrollTop)
  }
}
