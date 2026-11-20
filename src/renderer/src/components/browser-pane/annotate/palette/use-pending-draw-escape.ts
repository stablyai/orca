import { useEffect } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { isEditableKeyboardTarget } from '../../host-guest/input/browser-keyboard'
import { annotateEscOwner } from './annotate-esc-ownership'

/** While Draw waits (for the picker's teardown or the page's load) neither the picker nor the drawing owns Esc; this does. */
export function usePendingDrawEscape({
  waiting,
  pageId,
  exit
}: {
  waiting: boolean
  pageId: string
  exit: () => void
}): void {
  useEffect(() => {
    if (!waiting) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Same owner rule as the picker's and Draw's Esc: this page's surfaces, or no element when it was used last.
      if (
        event.key === 'Escape' &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !isEditableKeyboardTarget(event.target) &&
        annotateEscOwner(event.target) === pageId
      ) {
        event.preventDefault()
        exit()
      }
    }
    // Focus sits on the palette's Draw button meanwhile (it takes focus on tool change), so the app router sees Esc.
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [exit, pageId, waiting])
}
