// Input owns departure from following; layout and application writes also produce scroll events.

import { useCallback, useMemo } from 'react'
import {
  readerGestureDirection,
  readerGestureLeavesEnd,
  type ReaderGesture
} from './native-chat-autoscroll'

const READER_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' '
])

function isEditableTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  )
}

/** Nested scroll areas own gestures until they can chain into the transcript. */
function gestureReachesTranscript(
  target: EventTarget,
  transcript: HTMLElement,
  direction: -1 | 0 | 1
): boolean {
  if (!(target instanceof Element) || !transcript.contains(target)) {
    return false
  }
  for (
    let element: Element | null = target;
    element && element !== transcript;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
      continue
    }
    const canMove =
      direction < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight
    if (
      canMove ||
      style.overscrollBehaviorY === 'contain' ||
      style.overscrollBehaviorY === 'none'
    ) {
      return false
    }
  }
  return true
}

function gestureLeavesEnd(gesture: ReaderGesture, transcript: HTMLElement): boolean {
  return readerGestureLeavesEnd(gesture, {
    scrollTop: transcript.scrollTop,
    scrollHeight: transcript.scrollHeight,
    clientHeight: transcript.clientHeight
  })
}

type ReaderScrollCallbacks = {
  onReaderScroll: () => void
  /** The same gesture, for whatever was still moving the transcript to yield to it. */
  onTakeScroll?: () => void
  onLeaveEnd: () => void
}

export type NativeChatReaderScrollInputHandlers = Pick<
  React.HTMLAttributes<HTMLDivElement>,
  'onWheel' | 'onTouchMove' | 'onKeyDown' | 'onPointerDown' | 'tabIndex' | 'role'
>

/** Invalidate pending navigation on input, and detach only when the transcript can move away. */
export function nativeChatReaderScrollInputHandlers({
  onReaderScroll,
  onLeaveEnd
}: ReaderScrollCallbacks): NativeChatReaderScrollInputHandlers {
  const report = (gesture: ReaderGesture, event: React.SyntheticEvent<HTMLDivElement>): void => {
    const transcript = event.currentTarget
    if (
      gestureLeavesEnd(gesture, transcript) &&
      gestureReachesTranscript(event.target, transcript, readerGestureDirection(gesture))
    ) {
      onLeaveEnd()
    }
  }
  return {
    tabIndex: 0,
    role: 'region',
    onWheel: (event) => {
      if (event.ctrlKey || event.deltaY === 0) {
        return
      }
      onReaderScroll()
      report({ kind: 'wheel', deltaY: event.deltaY, zoom: event.ctrlKey }, event)
    },
    onTouchMove: (event) => {
      onReaderScroll()
      report({ kind: 'touch-drag' }, event)
    },
    onKeyDown: (event) => {
      if (!READER_SCROLL_KEYS.has(event.key) || isEditableTarget(event.target)) {
        return
      }
      const modified =
        event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== ' ')
      if (!modified && !event.defaultPrevented && !event.nativeEvent.isComposing) {
        onReaderScroll()
        report({ kind: 'key', key: event.key, shift: event.shiftKey }, event)
      }
    },
    // The scrollbar belongs to the scroller itself; a press on its content does not scroll.
    onPointerDown: (event) => {
      if (event.target === event.currentTarget) {
        onReaderScroll()
        report({ kind: 'scrollbar-press' }, event)
        return
      }
      if (event.target instanceof HTMLElement) {
        const { overflowY } = getComputedStyle(event.target)
        if (overflowY === 'auto' || overflowY === 'scroll') {
          onReaderScroll()
        }
      }
      report({ kind: 'content-press' }, event)
    }
  }
}

/** The transcript scroller's input props, and the wheel the rail overlaying it forwards. */
export function useNativeChatReaderScrollInput(
  scrollRef: React.RefObject<HTMLElement | null>,
  { onReaderScroll: onScrollInput, onTakeScroll, onLeaveEnd }: ReaderScrollCallbacks
): { scrollerProps: NativeChatReaderScrollInputHandlers; railWheel: (deltaY: number) => void } {
  const onReaderScroll = useCallback(() => {
    onScrollInput()
    onTakeScroll?.()
  }, [onScrollInput, onTakeScroll])
  const scrollerProps = useMemo(
    () => nativeChatReaderScrollInputHandlers({ onReaderScroll, onLeaveEnd }),
    [onLeaveEnd, onReaderScroll]
  )
  // Reported before the rail moves the transcript, so the gesture reads where it started.
  const railWheel = useCallback(
    (deltaY: number) => {
      if (deltaY === 0) {
        return
      }
      onReaderScroll()
      const transcript = scrollRef.current
      if (transcript && gestureLeavesEnd({ kind: 'wheel', deltaY, zoom: false }, transcript)) {
        onLeaveEnd()
      }
    },
    [onLeaveEnd, onReaderScroll, scrollRef]
  )
  return { scrollerProps, railWheel }
}
