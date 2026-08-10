import { useMemo, type DOMAttributes, type RefObject } from 'react'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldFocusNativeChatPaneFromPointerTarget,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type NativeChatPaneCaptureProps = Pick<
  DOMAttributes<HTMLDivElement>,
  | 'onPointerDownCapture'
  | 'onKeyDownCapture'
  | 'onMouseUpCapture'
  | 'onKeyUpCapture'
  | 'onContextMenuCapture'
>

/**
 * Pane-level capture handlers for the chat root: right-click opens the chat's own
 * menu (never the pane's), a plain click focuses the pane so the typing redirect
 * works, and typing anywhere outside an input lands in the composer.
 */
export function useNativeChatPaneCapture({
  rootRef,
  composerRef,
  onSelectionCapture,
  onContextMenuCapture
}: {
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  onSelectionCapture: () => void
  onContextMenuCapture: DOMAttributes<HTMLDivElement>['onContextMenuCapture']
}): NativeChatPaneCaptureProps {
  return useMemo(
    () => ({
      onPointerDownCapture: (event) => {
        if (event.button === 2) {
          onSelectionCapture()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (event.button === 0 && shouldFocusNativeChatPaneFromPointerTarget(event.target)) {
          rootRef.current?.focus({ preventScroll: true })
        }
      },
      onKeyDownCapture: (event) => {
        // Backspace/Delete outside an input focuses the composer (like typing)
        // but inserts nothing — let the now-focused field handle the keystroke.
        if (shouldFocusNativeChatComposerFromEditingKey(event)) {
          composerRef.current?.focus()
          return
        }
        if (!shouldRedirectNativeChatTyping(event)) {
          return
        }
        if (!composerRef.current?.insertTypedText(event.key)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
      },
      onMouseUpCapture: onSelectionCapture,
      onKeyUpCapture: onSelectionCapture,
      onContextMenuCapture
    }),
    [rootRef, composerRef, onSelectionCapture, onContextMenuCapture]
  )
}
