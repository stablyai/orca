import { useCallback, useEffect } from 'react'
import { useGuestEscape } from '../../host-guest/input/use-guest-escape'
import { interceptAnnotateEscape } from './annotate-escape-interceptor'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { isEditableKeyboardTarget } from '../../host-guest/input/browser-keyboard'
import { annotateEscOwner } from './annotate-esc-ownership'
import type { MarkupModeController } from '../capture/useMarkupMode'

/**
 * While Draw waits (for the picker's teardown, the page's load or its capture) neither the picker nor the drawing owns
 * Esc; this does. The drawing mounts only once the captured image arrives.
 */
export function usePendingDrawEscape({
  waiting: startWaiting,
  markup,
  pageId,
  exit
}: {
  waiting: boolean
  markup: Pick<MarkupModeController, 'state'>
  pageId: string
  exit: () => void
}): void {
  const waiting = startWaiting || markup.state === 'capturing'
  const exitUnlessIntercepted = useCallback(() => {
    if (!interceptAnnotateEscape(pageId)) {
      exit()
    }
  }, [exit, pageId])
  useGuestEscape(pageId, waiting, exitUnlessIntercepted)
  useEffect(() => {
    if (!waiting) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Same owner rule as the picker's and Draw's Esc: this page's surfaces, or no element when it was used last.
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !isEditableKeyboardTarget(event.target) &&
        annotateEscOwner(event.target) === pageId
      ) {
        event.preventDefault()
        exitUnlessIntercepted()
      }
    }
    // Focus sits on the palette's Draw button meanwhile (it takes focus on tool change), so the app router sees Esc.
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [exitUnlessIntercepted, pageId, waiting])
}
