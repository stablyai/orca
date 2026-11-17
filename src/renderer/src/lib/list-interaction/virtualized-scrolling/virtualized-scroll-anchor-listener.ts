import type { MutableRefObject } from 'react'
import { shouldCancelVirtualizedScrollOffsetRestore } from './virtualizedScrollOffsetRestore'
import type { ProgrammaticScrollMarks } from './programmatic-scroll-marks'

type CreateVirtualizedScrollAnchorListenerArgs<TScrollElement extends Element> = {
  el: TScrollElement
  getHasDirectScrollInput: () => (() => boolean) | undefined
  getMarks: () => ProgrammaticScrollMarks | undefined
  getRecordAnchorOnScroll: () => boolean
  // Sync the owner’s offset/anchor after our writes so later divergence checks cannot misread them as user input.
  onProgrammaticScroll: (scrollTop: number) => void
  pendingRestoreRef: MutableRefObject<boolean>
  recordCurrentAnchor: () => void
  recordUserScroll: (scrollTop: number) => void
  targetOffset: number
  scrollOffsetRef: MutableRefObject<number>
}

/** Restore persisted offsets on mount; marks identify programmatic writes and clamped landings, with legacy input-window classification when marks are absent. */
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
}: CreateVirtualizedScrollAnchorListenerArgs<TScrollElement>): {
  onScroll: (event: Event) => void
  cancelMountRestore: () => void
} {
  // An unchanged position emits no scroll event; arming restore would leave a stale target active forever.
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

  const onScroll = (event: Event): void => {
    const marks = getMarks()
    if (marks) {
      const isProgrammatic = marks.consume(event, el.scrollTop, el.scrollHeight - el.clientHeight)
      if (
        !isProgrammatic &&
        el.scrollTop === scrollOffsetRef.current &&
        getHasDirectScrollInput()?.() !== true
      ) {
        return
      }
      if (restoring && isProgrammatic && pendingRestoreRef.current) {
        // Source-row restoration owns this landing; pixel restoration must not replace its anchor.
        restoring = false
        onProgrammaticScroll(el.scrollTop)
        return
      }
      if (restoring) {
        if (el.scrollTop === targetOffset) {
          completeRestore()
          return
        }
        if (!isProgrammatic) {
          const maxScrollOffset = el.scrollHeight - el.clientHeight
          // An unreachable target at max scroll is browser clamping; await more range unless direct input takes over.
          const clampExplainsLanding =
            targetOffset > maxScrollOffset && el.scrollTop >= maxScrollOffset - 2
          if (!clampExplainsLanding || getHasDirectScrollInput()?.() === true) {
            // Unmarked scrolls unexplained by clamping are user takeover; their position wins.
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
      // Direct wheel/touch input takes over even while persisted-offset restoration is pending.
      restoring = false
      pendingRestoreRef.current = false
      recordCurrentAnchor()
      return
    }
    if (restoring) {
      // Estimated mount heights can clamp the offset; do not persist that landing until the intended offset is reachable.
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
  return {
    onScroll,
    cancelMountRestore: () => {
      restoring = false
    }
  }
}
