import { getShortcutPlatform } from './shortcut-platform'

type CaretKeyEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Home/End that should move a search input's caret; Ctrl/Cmd/Alt variants stay list jumps. */
export function isCommandInputCaretKey(event: CaretKeyEvent): boolean {
  if (
    (event.key !== 'Home' && event.key !== 'End') ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return false
  }
  // Why: macOS maps plain Home/End to document scroll, which never moves an input caret.
  return event.shiftKey || getShortcutPlatform() !== 'darwin'
}
