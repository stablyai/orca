import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type NativeChatPasteBridgeRefs = {
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
}

export function useNativeChatPasteBridge({
  rootRef,
  composerRef
}: NativeChatPasteBridgeRefs): () => void {
  const pasteClipboardIntoComposer = useCallback(() => {
    composerRef.current?.pasteFromClipboard()
  }, [composerRef])

  // Capture at the pane root so repeated composer mounts do not miss image paste.
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const onPaste = (event: ClipboardEvent): void => {
      composerRef.current?.handlePasteEvent(event)
    }
    root.addEventListener('paste', onPaste, { capture: true })
    return () => {
      root.removeEventListener('paste', onPaste, { capture: true })
    }
  }, [composerRef, rootRef])

  useEffect(() => {
    const onAppMenuPaste = (event: Event): void => {
      const root = rootRef.current
      const activeElement = document.activeElement
      // The app-menu paste event is window-scoped; only claim it when focus is
      // inside this chat pane so multiple panes don't all react to one Cmd+V.
      if (!root || !(activeElement instanceof Element) || !root.contains(activeElement)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      pasteClipboardIntoComposer()
    }

    window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    return () => {
      window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    }
  }, [pasteClipboardIntoComposer, rootRef])

  return pasteClipboardIntoComposer
}
