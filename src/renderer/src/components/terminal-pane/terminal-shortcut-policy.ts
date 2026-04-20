export type TerminalShortcutEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

export type MacOptionAsAlt = 'true' | 'false' | 'left' | 'right'

// Why: macOS composition replaces event.key for punctuation, so we map
// event.code to the unmodified character for Esc+ sequences.
const PUNCTUATION_CODE_MAP: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`'
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
  isMac: boolean,
  macOptionAsAlt: MacOptionAsAlt = 'false',
  optionKeyLocation: number = 0
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
    // Why: Cmd+←/→ on macOS conventionally moves to start/end of line in
    // terminals (iTerm2, Ghostty). xterm.js has no default mapping for
    // Cmd+Arrow, so we translate to readline's Ctrl+A (\x01) / Ctrl+E (\x05),
    // which work universally across bash/zsh/fish and most TUI editors.
    if (event.key === 'ArrowLeft') {
      return { type: 'sendInput', data: '\x01' }
    }
    if (event.key === 'ArrowRight') {
      return { type: 'sendInput', data: '\x05' }
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

  if (
    !isMac &&
    !event.metaKey &&
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    // Why: Windows Terminal, GNOME Terminal, and Konsole all bind Ctrl+←/→ for
    // word navigation on Linux/Windows — but xterm.js emits \e[1;5D / \e[1;5C,
    // which default readline (bash, zsh) does not bind to backward-word /
    // forward-word. Translate to \eb / \ef (same bytes as our Alt+Arrow rule)
    // so Ctrl+←/→ works for word-nav matching user expectations on those
    // platforms without requiring a custom inputrc.
    //
    // Mac-gated: Ctrl+Arrow on macOS is reserved for Mission Control / Spaces
    // navigation at the OS level and should never reach the app.
    return { type: 'sendInput', data: event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf' }
  }

  // Why: with macOptionIsMeta disabled (to let non-US keyboard layouts compose
  // characters like @ and €), xterm.js no longer translates Option+letter into
  // Esc+letter automatically. We match on event.code (physical key) rather than
  // event.key because macOS composition replaces event.key with the composed
  // character (e.g. Option+B reports key='∫', not key='b').
  //
  // The handling depends on the macOptionAsAlt setting (mirrors Ghostty):
  // - 'true':  xterm handles all Option as Meta natively; nothing to do here.
  // - 'false': compensate the three most critical readline shortcuts (B/F/D).
  // - 'left'/'right': the designated Option key acts as full Meta (emit Esc+
  //   for any single letter); the other key composes, with B/F/D compensated.
  if (isMac && !event.metaKey && !event.ctrlKey && event.altKey && !event.shiftKey) {
    // Why: event.location on a character key reports that key's position (always
    // 0 for standard keys), NOT which modifier is held. The caller must track
    // the Option key's own keydown location and pass it as optionKeyLocation.
    const isLeftOption = optionKeyLocation === 1
    const isRightOption = optionKeyLocation === 2

    const shouldActAsMeta =
      (macOptionAsAlt === 'left' && isLeftOption) || (macOptionAsAlt === 'right' && isRightOption)

    if (shouldActAsMeta) {
      // Emit Esc+key for letter keys (e.g. Option+B → \x1bb)
      if (event.code?.startsWith('Key') && event.code.length === 4) {
        const letter = event.code.charAt(3).toLowerCase()
        return { type: 'sendInput', data: `\x1b${letter}` }
      }
      // Emit Esc+digit for number keys (e.g. Option+1 → \x1b1)
      if (event.code?.startsWith('Digit') && event.code.length === 6) {
        return { type: 'sendInput', data: `\x1b${event.code.charAt(5)}` }
      }
      const punct = event.code ? PUNCTUATION_CODE_MAP[event.code] : undefined
      if (punct) {
        return { type: 'sendInput', data: `\x1b${punct}` }
      }
    }

    // In 'false', 'left', or 'right' mode, the compose-side Option key still
    // needs the three most critical readline shortcuts patched.
    if (macOptionAsAlt !== 'true' && !shouldActAsMeta) {
      if (event.code === 'KeyB') {
        return { type: 'sendInput', data: '\x1bb' }
      }
      if (event.code === 'KeyF') {
        return { type: 'sendInput', data: '\x1bf' }
      }
      if (event.code === 'KeyD') {
        return { type: 'sendInput', data: '\x1bd' }
      }
    }
  }

  return null
}
