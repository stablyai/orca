import { useRef } from 'react'

/** Radix restores focus to the trigger on close, which is right for a visit that changed nothing
 *  and wrong after one that did: the message is what comes next. `notePick` marks the visit as
 *  used; a click that took focus somewhere else keeps it. */
export function useNativeChatPickerFocusReturn(focusComposer: (() => void) | undefined): {
  /** Goes on the trigger, whose own press closes the surface. */
  triggerRef: React.RefObject<HTMLButtonElement | null>
  notePick: () => void
  onInteractOutside: (event: Event) => void
  onCloseAutoFocus: (event: Event) => void
} {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const picked = useRef(false)
  const interactedOutside = useRef(false)
  return {
    triggerRef,
    notePick: () => {
      picked.current = true
    },
    onInteractOutside: (event: Event) => {
      // Why: Radix reports a press on the trigger too, and that press only closes the surface.
      if (!(event.target instanceof Node && triggerRef.current?.contains(event.target))) {
        interactedOutside.current = true
      }
    },
    onCloseAutoFocus: (event: Event) => {
      const used = picked.current
      // Read after the click that closed it has settled its own focus.
      const focusedElsewhere =
        interactedOutside.current &&
        document.activeElement !== null &&
        document.activeElement !== document.body
      picked.current = false
      interactedOutside.current = false
      if (!used || !focusComposer || focusedElsewhere) {
        return
      }
      event.preventDefault()
      focusComposer()
    }
  }
}
