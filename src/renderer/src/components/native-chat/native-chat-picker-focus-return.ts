import { useLayoutEffect, useRef, useState } from 'react'

/** After a pick, focus the composer unless an outside click already moved focus elsewhere. */
export function useNativeChatPickerFocusReturn(
  focusComposer: (() => void) | undefined,
  restoreDisappearingTrigger = false
): {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  notePick: () => void
  onInteractOutside: (event: Event) => void
  onCloseAutoFocus: (event: Event) => void
} {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const picked = useRef(false)
  const interactedOutside = useRef(false)
  const [returnAfterClose, setReturnAfterClose] = useState(false)
  useLayoutEffect(() => {
    if (!returnAfterClose) {
      return
    }
    setReturnAfterClose(false)
    const trigger = triggerRef.current
    // The closed layout may have removed More after the pane expanded.
    if (trigger?.isConnected && !trigger.closest('[inert], [aria-hidden="true"]')) {
      trigger.focus()
    } else {
      focusComposer?.()
    }
  }, [returnAfterClose, focusComposer])
  return {
    triggerRef,
    notePick: () => {
      picked.current = true
    },
    onInteractOutside: (event: Event) => {
      // Radix also reports trigger presses, which only close the surface.
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
      if (restoreDisappearingTrigger && !used && !focusedElsewhere) {
        event.preventDefault()
        setReturnAfterClose(true)
        return
      }
      if (!used || !focusComposer || focusedElsewhere) {
        return
      }
      event.preventDefault()
      focusComposer()
    }
  }
}
