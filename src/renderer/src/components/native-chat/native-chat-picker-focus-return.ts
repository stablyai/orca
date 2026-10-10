import { useRef } from 'react'

/** Radix restores focus to the trigger on close, which is right for a dismissal and wrong after a
 *  pick. `notePick` marks the choices that close the surface, so only those reach `focusComposer`. */
export function useNativeChatPickerFocusReturn(focusComposer: (() => void) | undefined): {
  notePick: () => void
  onCloseAutoFocus: (event: Event) => void
} {
  const picked = useRef(false)
  return {
    notePick: () => {
      picked.current = true
    },
    onCloseAutoFocus: (event: Event) => {
      if (!picked.current) {
        return
      }
      picked.current = false
      if (!focusComposer) {
        return
      }
      event.preventDefault()
      focusComposer()
    }
  }
}
