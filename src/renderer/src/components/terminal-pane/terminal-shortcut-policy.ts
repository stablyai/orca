export type TerminalShortcutEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

export type TerminalShortcutAction =
  | { type: 'copySelection' }
  | { type: 'toggleSearch' }
  | { type: 'clearActivePane' }
  | { type: 'focusPane'; direction: 'next' | 'previous' }
  | { type: 'toggleExpandActivePane' }
  | { type: 'closeActivePane' }
  | { type: 'splitActivePane'; direction: 'vertical' | 'horizontal' }
  | { type: 'sendInput'; data: string }

export function resolveTerminalShortcutAction(
  event: TerminalShortcutEvent,
  isMac: boolean
): TerminalShortcutAction | null {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!event.repeat && mod && !event.altKey) {
    const lowerKey = event.key.toLowerCase()

    if (event.shiftKey && lowerKey === 'c') {
      return { type: 'copySelection' }
    }

    if (!event.shiftKey && lowerKey === 'f') {
      return { type: 'toggleSearch' }
    }

    if (!event.shiftKey && lowerKey === 'k') {
      return { type: 'clearActivePane' }
    }

    if (!event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
      return {
        type: 'focusPane',
        direction: event.code === 'BracketRight' ? 'next' : 'previous'
      }
    }

    if (
      event.shiftKey &&
      event.key === 'Enter' &&
      (event.code === 'Enter' || event.code === 'NumpadEnter')
    ) {
      return { type: 'toggleExpandActivePane' }
    }

    if (!event.shiftKey && lowerKey === 'w') {
      return { type: 'closeActivePane' }
    }

    if (lowerKey === 'd') {
      return {
        type: 'splitActivePane',
        direction: event.shiftKey ? 'horizontal' : 'vertical'
      }
    }
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.shiftKey &&
    event.key === 'Enter'
  ) {
    return { type: 'sendInput', data: '\x1b[13;2u' }
  }

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === 'Backspace'
  ) {
    return { type: 'sendInput', data: '\x17' }
  }

  if (isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (event.key === 'Backspace') {
      return { type: 'sendInput', data: '\x15' }
    }
    if (event.key === 'Delete') {
      return { type: 'sendInput', data: '\x0b' }
    }
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    event.key === 'Backspace'
  ) {
    return { type: 'sendInput', data: '\x1b\x7f' }
  }

  // Why: the terminal shortcut layer is an explicit allowlist, not a generic
  // "modifier means app shortcut" rule. Keeping this list narrow prevents Orca
  // from swallowing readline/emacs control chords like Ctrl+R, Ctrl+U, Ctrl+E,
  // Alt+B, Alt+F, and Alt+D when the shell owns terminal focus.
  return null
}
