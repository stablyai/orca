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
  | { type: 'equalizePaneSizes' }
  | { type: 'toggleExpandActivePane' }
  | { type: 'setTitle' }
  | { type: 'clearPaneTitle' }
  | { type: 'closeActivePane' }
  | { type: 'splitActivePane'; direction: 'vertical' | 'horizontal' }
  | { type: 'scrollViewport'; position: 'top' | 'bottom' }
  | { type: 'sendInput'; data: string }

/** Kitty keyboard protocol modifier field: 1 + shift(1) + alt(2). */
function kittyAltModifiers(shiftKey: boolean): number {
  return shiftKey ? 4 : 3
}

/** The un-shifted ASCII character for a physical key code (letters, digits,
 *  and the punctuation map above), or undefined for unmapped codes. */
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
 * Resolves terminal keyboard events before xterm receives them.
 * Keeps configurable Orca shortcuts and terminal byte fallbacks in one
 * platform-aware policy so renderer handlers do not duplicate key checks.
 */
export function resolveTerminalShortcutAction(
  event: TerminalShortcutEvent,
  isMac: boolean,
  macOptionAsAlt: MacOptionAsAlt = 'false',
  optionKeyLocation: number = 0,
  isWindows: boolean = false,
  keybindings?: KeybindingOverrides,
  // Why: lazily reports whether the active pane is a local native Windows
  // ConPTY. Only consulted for Shift+Enter and Ctrl+Arrow, so execution-host
  // lookup stays off every other keystroke.
  isLocalWindowsConptyPane?: () => boolean,
  // Why: lazily reports whether the active pane's application has enabled the
  // kitty keyboard protocol (CSI > u). Gates the Option-as-Alt compensation
  // below on the application's own opt-in, so shells keep composition.
  isKittyKeyboardActivePane?: () => boolean,
  // Why: kitty key reports carry the key's unshifted codepoint in the active
  // layout; the physical-code table above is US QWERTY and reports the wrong
  // key on Dvorak/Colemak/AZERTY-class layouts. This resolves through
  // Chromium's KeyboardLayoutMap when it is available.
  layoutBaseCharacterForCode?: (code: string) => string | undefined,
  // Why: lazily resolves the active pane's Windows encoding. Only consulted for
  // Shift+Enter so agent-state lookup stays off every other keystroke.
  getWindowsShiftEnterEncoding?: () => WindowsShiftEnterEncoding
): TerminalShortcutAction | null {
  const platform: NodeJS.Platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'
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
    // Why: Droid needs CSI-u but Codex needs Esc+CR; preserve legacy bytes for
    // SSH/WSL/remote peers that cannot be safely classified from this client.
    const useLocalWindowsCapability = isWindows && isLocalWindowsConptyPane?.() !== false
    const encoding = useLocalWindowsCapability
      ? (getWindowsShiftEnterEncoding?.() ?? 'alt-enter')
      : isWindows
        ? 'alt-enter'
        : 'csi-u'
    return { type: 'sendInput', data: encoding === 'csi-u' ? '\x1b[13;2u' : '\x1b\r' }
  }

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === 'Enter'
  ) {
    // Why: xterm.js collapses Ctrl+Enter to a bare CR, so TUIs that expect
    // modified Enter chords never receive the distinct input and treat it as
    // plain Enter. Forward the kitty CSI-u sequence directly (modifier code
    // 5 = Ctrl; cf. 2 = Shift above) so cue/queue behavior reaches the TUI.
    // Sibling of the Shift+Enter case; a Windows fallback is not added yet
    // because, unlike #2418's Codex-on-PowerShell inertness, no Windows TUI is
    // known to drop the CSI-u form for Ctrl+Enter.
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
    // Why: macOS terminal users expect Cmd+↑/↓ to jump through scrollback
    // without writing escape bytes into the shell.
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
    // Why: a kitty-protocol TUI binds the CSI 127;3u that xterm's kitty
    // encoder emits natively; the legacy \x1b\x7f fallback would bypass it.
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
    // Why: a kitty-protocol TUI binds alt+arrow via the CSI 1;3D / 1;3C that
    // xterm's kitty encoder emits natively; \eb/\ef would reach it as alt+b/f.
    if (isKittyKeyboardActivePane?.()) {
      return null
    }
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
    // Why: local Windows ConPTY shells (PowerShell/cmd via PSReadLine) already
    // bind Ctrl+←/→ to word-nav, and they treat \eb/\ef (Alt+b/f) as
    // Escape→RevertLine followed by a self-inserted "b"/"f" — so the translation
    // below prints a stray letter instead of moving the cursor (issue: Ctrl+→
    // types "b"/"f" in PowerShell). Defer to xterm's native \e[1;5D / \e[1;5C
    // there. Remote/WSL panes on a Windows client run readline and still need
    // the translation, so this is gated on a genuine local native ConPTY, not
    // merely on the client being Windows.
    if (isLocalWindowsConptyPane?.()) {
      return null
    }
    // Why: default readline (bash, zsh) does not bind the \e[1;5D / \e[1;5C that
    // xterm.js emits for Ctrl+←/→, so Linux and remote/WSL shells need the
    // translation to \eb / \ef (same bytes as our Alt+Arrow rule) for word-nav
    // to work without a custom inputrc.
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
  // - kitty-protocol pane (any other mode): the TUI asked for modifier-accurate
  //   keys, so every Option chord is encoded as kitty CSI-u with the physical
  //   base key (Option+P → \x1b[112;3u). Without this, xterm's kitty encoder
  //   reports the composed codepoint (alt+π), which no TUI binds — the chord
  //   neither triggers the hotkey nor types the character (issue: OMP Alt+P /
  //   Alt+M dead on compose layouts). Dead keys are exempt so composition
  //   (Option+E → ´) keeps working.
  // - 'false': compensate the three most critical readline shortcuts (B/F/D).
  // - 'left'/'right': the designated Option key acts as full Meta (emit Esc+
  //   for any single letter); the other key composes, with B/F/D compensated.
  if (isMac && !event.metaKey && !event.ctrlKey && event.altKey && macOptionAsAlt !== 'true') {
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
      // Why: event.location on a character key reports that key's position
      // (always 0 for standard keys), NOT which modifier is held. The caller
      // must track the Option key's own keydown location and pass it as
      // optionKeyLocation.
      const isLeftOption = optionKeyLocation === 1
      const isRightOption = optionKeyLocation === 2

      const shouldActAsMeta =
        (macOptionAsAlt === 'left' && isLeftOption) || (macOptionAsAlt === 'right' && isRightOption)

      if (shouldActAsMeta) {
        // Emit Esc+key (e.g. Option+B → \x1bb) for letters, digits, and
        // mapped punctuation.
        const character = resolveUnshiftedCharacterForCode(event.code)
        if (character) {
          return { type: 'sendInput', data: `\x1b${character}` }
        }
      }

      // In 'false', 'left', or 'right' mode, the compose-side Option key still
      // needs the three most critical readline shortcuts patched.
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
