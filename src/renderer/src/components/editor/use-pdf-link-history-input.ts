import { useEffect, type RefObject } from 'react'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { pdfViewerOwnsFind } from './use-pdf-viewer-find-shortcut'

type PdfLinkHistoryDirection = 'back' | 'forward'

// Mouse side buttons, mapped the same way as in remote browser pages.
const MOUSE_BACK_BUTTON = 3
const MOUSE_FORWARD_BUTTON = 4

function keyDirection(
  event: KeyboardEvent,
  keybindings: KeybindingOverrides | undefined
): PdfLinkHistoryDirection | null {
  const platform = getShortcutPlatform()
  if (keybindingMatchesAction('editor.pdfBack', event, platform, keybindings)) {
    return 'back'
  }
  if (keybindingMatchesAction('editor.pdfForward', event, platform, keybindings)) {
    return 'forward'
  }
  return null
}

/** Back/forward through this PDF's link jumps from the keyboard and the mouse side buttons. */
export function usePdfLinkHistoryInput({
  rootRef,
  ownsCommands,
  keybindings,
  navigate
}: {
  rootRef: RefObject<HTMLElement | null>
  ownsCommands: boolean
  keybindings: KeybindingOverrides | undefined
  navigate: (direction: PdfLinkHistoryDirection) => void
}): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const direction = keyDirection(event, keybindings)
      // Same ownership as Find: hidden workspaces and other splits retain PDFs.
      if (!direction || !pdfViewerOwnsFind(rootRef.current, event.target, ownsCommands)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      navigate(direction)
    }
    addAppKeyListener('keydown', handleKeyDown)
    return () => removeAppKeyListener('keydown', handleKeyDown)
  }, [keybindings, navigate, ownsCommands, rootRef])

  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const handleMouseUp = (event: MouseEvent): void => {
      const direction =
        event.button === MOUSE_BACK_BUTTON
          ? 'back'
          : event.button === MOUSE_FORWARD_BUTTON
            ? 'forward'
            : null
      if (!direction) {
        return
      }
      event.preventDefault()
      navigate(direction)
    }
    root.addEventListener('mouseup', handleMouseUp)
    return () => root.removeEventListener('mouseup', handleMouseUp)
  }, [navigate, rootRef])
}
