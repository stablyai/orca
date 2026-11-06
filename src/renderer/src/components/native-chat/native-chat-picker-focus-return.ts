import { useRef } from 'react'

/** After a pick, focus the composer unless an outside click already moved focus elsewhere. */
export function useNativeChatPickerFocusReturn(focusComposer: (() => void) | undefined): {
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
      if (!used || !focusComposer || focusedElsewhere) {
        return
      }
      event.preventDefault()
      focusComposer()
    }
  }
}
