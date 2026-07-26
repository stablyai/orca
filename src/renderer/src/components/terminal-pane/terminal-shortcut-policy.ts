import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import type { WindowsShiftEnterEncoding } from './terminal-windows-shift-enter'

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

// Why: macOS composition rewrites event.key for punctuation, so map event.code to the unmodified char for Esc+ sequences.
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
  | { type: 'equalizePaneSizes' }
  | { type: 'toggleExpandActivePane' }
  | { type: 'setTitle' }
  | { type: 'clearPaneTitle' }
  | { type: 'closeActivePane' }
  | { type: 'splitActivePane'; direction: 'vertical' | 'horizontal' }
  | { type: 'scrollViewport'; position: 'top' | 'bottom' }
  | { type: 'sendInput'; data: string }
  | { type: 'switchInputSource' }

/** Kitty keyboard protocol modifier field: 1 + shift(1) + alt(2). */
function kittyAltModifiers(shiftKey: boolean): number {
  return shiftKey ? 4 : 3
}

/** Un-shifted ASCII character for a physical key code (letters, digits, punctuation map), or undefined. */
function resolveUnshiftedCharacterForCode(code: string | undefined): string | undefined {
  if (!code) {
    return undefined
  }
  if (code.startsWith('Key') && code.length === 4) {
    return code.charAt(3).toLowerCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.charAt(5)
  }
  return PUNCTUATION_CODE_MAP[code]
}

/**
 * Resolves terminal keyboard events before xterm receives them, centralizing
 * Orca shortcuts and terminal byte fallbacks in one platform-aware policy.
 */
export function resolveTerminalShortcutAction(
  event: TerminalShortcutEvent,
  isMac: boolean,
  macOptionAsAlt: MacOptionAsAlt = 'false',
  optionKeyLocation: number = 0,
  isWindows: boolean = false,
  keybindings?: KeybindingOverrides,
  // Why: lazy so execution-host lookup (local native Windows ConPTY) runs only on Ctrl+Arrow, not every keystroke.
  isLocalWindowsConptyPane?: () => boolean,
  // Why: gates Option-as-Alt compensation on the app's own kitty-protocol (CSI > u) opt-in, so shells keep composition.
  isKittyKeyboardActivePane?: () => boolean,
  // Why: the physical-code table above is US QWERTY; resolve via Chromium's KeyboardLayoutMap for Dvorak/Colemak/AZERTY layouts.
  layoutBaseCharacterForCode?: (code: string) => string | undefined,
  // Why: lazy so agent-state lookup for the pane's Windows encoding runs only on Shift+Enter, not every keystroke.
  getWindowsShiftEnterEncoding?: () => WindowsShiftEnterEncoding,
  // Why: keybindings follow the client OS, but byte protocols follow the PTY host — they differ for macOS clients on Windows runtimes.
  isWindowsTerminalHost: () => boolean = () => isWindows
): TerminalShortcutAction | null {
  const platform: NodeJS.Platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'

  // Why: capture this chord even on repeat without blocking the OS default input-source switch.
  if (keybindingMatchesAction('terminal.switchInputSource', event, platform, keybindings)) {
    return { type: 'switchInputSource' }
  }

  if (!event.repeat) {
    if (keybindingMatchesAction('terminal.copySelection', event, platform, keybindings)) {
      return { type: 'copySelection' }
    }

    if (keybindingMatchesAction('terminal.search', event, platform, keybindings)) {
      return { type: 'toggleSearch' }
    }

    if (keybindingMatchesAction('terminal.clear', event, platform, keybindings)) {
      return { type: 'clearActivePane' }
    }

    if (keybindingMatchesAction('terminal.focusPreviousPane', event, platform, keybindings)) {
      return { type: 'focusPane', direction: 'previous' }
    }

    if (keybindingMatchesAction('terminal.focusNextPane', event, platform, keybindings)) {
      return { type: 'focusPane', direction: 'next' }
    }

    if (keybindingMatchesAction('terminal.equalizePaneSizes', event, platform, keybindings)) {
      return { type: 'equalizePaneSizes' }
    }

    if (keybindingMatchesAction('terminal.expandPane', event, platform, keybindings)) {
      return { type: 'toggleExpandActivePane' }
    }

    if (keybindingMatchesAction('terminal.setTitle', event, platform, keybindings)) {
      return { type: 'setTitle' }
    }

    if (keybindingMatchesAction('terminal.clearPaneTitle', event, platform, keybindings)) {
      return { type: 'clearPaneTitle' }
    }

    if (keybindingMatchesAction('terminal.closePane', event, platform, keybindings)) {
      return { type: 'closeActivePane' }
    }

    if (keybindingMatchesAction('terminal.splitRight', event, platform, keybindings)) {
      return { type: 'splitActivePane', direction: 'vertical' }
    }

    if (keybindingMatchesAction('terminal.splitDown', event, platform, keybindings)) {
      return { type: 'splitActivePane', direction: 'horizontal' }
    }
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.shiftKey &&
    event.key === 'Enter'
  ) {
    // Why: negotiated KKP is authoritative everywhere; trusted pane evidence also preserves Droid's Windows encoding without KKP.
    const windowsHost = isWindowsTerminalHost()
    const hasTrustedWindowsCsiU = windowsHost && getWindowsShiftEnterEncoding?.() === 'csi-u'
    // Why: CSI-u is application input, not universal; without trusted Windows evidence, require active KKP negotiation.
    const canSendCsiU = hasTrustedWindowsCsiU || isKittyKeyboardActivePane?.() === true
    return { type: 'sendInput', data: canSendCsiU ? '\x1b[13;2u' : '\x1b\r' }
  }

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === 'Enter'
  ) {
    // Why: xterm.js collapses Ctrl+Enter to a bare CR, so forward kitty CSI-u (modifier 5 = Ctrl) so the chord reaches TUIs; no Windows fallback yet (#2418).
    return { type: 'sendInput', data: '\x1b[13;5u' }
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
    // Why: xterm.js has no Cmd+Arrow mapping; translate Cmd+←/→ to readline Ctrl+A/Ctrl+E for line start/end (iTerm2/Ghostty).
    if (event.key === 'ArrowLeft') {
      return { type: 'sendInput', data: '\x01' }
    }
    if (event.key === 'ArrowRight') {
      return { type: 'sendInput', data: '\x05' }
    }
    // Why: macOS users expect Cmd+↑/↓ to scroll scrollback, not write escape bytes to the shell.
    if (event.key === 'ArrowUp') {
      return { type: 'scrollViewport', position: 'top' }
    }
    if (event.key === 'ArrowDown') {
      return { type: 'scrollViewport', position: 'bottom' }
    }
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    event.key === 'Backspace'
  ) {
    // Why: a kitty-protocol TUI binds the CSI 127;3u xterm emits natively; the legacy \x1b\x7f fallback would bypass it.
    if (isKittyKeyboardActivePane?.()) {
      return null
    }
    return { type: 'sendInput', data: '\x1b\x7f' }
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    // Why: a kitty-protocol TUI binds alt+arrow via xterm's native CSI 1;3D/C; \eb/\ef would reach it as alt+b/f.
    if (isKittyKeyboardActivePane?.()) {
      return null
    }
    // Why: readline doesn't bind xterm's \e[1;3D/C for alt+←/→, so translate to \eb/\ef for word-nav (iTerm2 "Esc+" behavior).
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
    // Why: local Windows ConPTY (PSReadLine) binds Ctrl+←/→ itself; sending \eb/\ef prints stray b/f. Remote/WSL run readline.
    if (isLocalWindowsConptyPane?.()) {
      return null
    }
    // Why: readline ignores xterm's \e[1;5D/C, so translate Ctrl+←/→ to \eb/\ef for word-nav; !isMac since Mac reserves Ctrl+Arrow.
    return { type: 'sendInput', data: event.key === 'ArrowLeft' ? '\x1bb' : '\x1bf' }
  }

  // Why: macOptionIsMeta stays off so non-US layouts can compose @/€; match event.code since composition rewrites event.key.
  if (isMac && !event.metaKey && !event.ctrlKey && event.altKey && macOptionAsAlt !== 'true') {
    // Why: kitty pane — encode the physical base key as CSI-u; the composed codepoint (alt+π) binds nothing, Dead keys exempt to keep composition.
    if (event.key !== 'Dead' && isKittyKeyboardActivePane?.()) {
      const baseCharacter =
        (event.code ? layoutBaseCharacterForCode?.(event.code) : undefined) ??
        resolveUnshiftedCharacterForCode(event.code)
      if (baseCharacter) {
        return {
          type: 'sendInput',
          data: `\x1b[${baseCharacter.codePointAt(0)};${kittyAltModifiers(event.shiftKey)}u`
        }
      }
    }

    if (!event.shiftKey) {
      // Why: event.location reflects the char key, not the held modifier, so the caller supplies Option's tracked keydown location.
      const isLeftOption = optionKeyLocation === 1
      const isRightOption = optionKeyLocation === 2

      const shouldActAsMeta =
        (macOptionAsAlt === 'left' && isLeftOption) || (macOptionAsAlt === 'right' && isRightOption)

      if (shouldActAsMeta) {
        const character = resolveUnshiftedCharacterForCode(event.code)
        if (character) {
          return { type: 'sendInput', data: `\x1b${character}` }
        }
      }

      // Compose-side Option still needs the critical readline shortcuts (B/F/D) patched.
      if (!shouldActAsMeta) {
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
  }

  return null
}
