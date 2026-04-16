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
      if (isMac) {
        return {
          type: 'splitActivePane',
          direction: event.shiftKey ? 'horizontal' : 'vertical'
        }
      }
      // Why: on Windows/Linux, Ctrl+D is the standard EOF signal for terminals.
      // Binding Ctrl+D to split-pane would swallow EOF and break shell workflows
      // (see #586). Only Ctrl+Shift+D triggers split on non-Mac platforms;
      // Ctrl+D (without Shift) falls through to the terminal as normal input.
      if (event.shiftKey) {
        return { type: 'splitActivePane', direction: 'vertical' }
      }
      return null
    }
  }

  // Why: on Windows/Linux, Alt+Shift+D splits the pane down (horizontal).
  // This lives outside the mod+!alt block above because it uses Alt instead
  // of Ctrl, following the Windows Terminal convention for split shortcuts
  // and avoiding the Ctrl+D / EOF conflict (see #586).
  if (
    !isMac &&
    !event.repeat &&
    !event.metaKey &&
    !event.ctrlKey &&
    event.altKey &&
    event.shiftKey &&
    event.key.toLowerCase() === 'd'
  ) {
    return { type: 'splitActivePane', direction: 'horizontal' }
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

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    // Why: xterm.js would otherwise emit \e[1;3D / \e[1;3C for option/alt+arrow,
    // which default readline (bash, zsh) does not bind to backward-word /
    // forward-word — so word navigation silently doesn't work without a custom
    // inputrc. Translate to \eb / \ef (readline's default word-nav bindings) so
    // option+←/→ on macOS and alt+←/→ on Linux/Windows behave like they do in
    // iTerm2's "Esc+" option-key mode. Platform-agnostic: both produce altKey.
    return { type: 'sendInput', data: event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf' }
  }

  // Why: the terminal shortcut layer is an explicit allowlist, not a generic
  // "modifier means app shortcut" rule. Keeping this list narrow prevents Orca
  // from swallowing readline/emacs control chords like Ctrl+R, Ctrl+U, Ctrl+E,
  // Alt+B, Alt+F, and Alt+D when the shell owns terminal focus.
  return null
}
