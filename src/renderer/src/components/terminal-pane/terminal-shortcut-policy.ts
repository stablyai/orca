import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingMatchOptions,
  type KeybindingOverrides,
  type LayoutCharacterLookup,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import type { WindowsShiftEnterEncoding } from './terminal-windows-shift-enter'
import {
  resolveTerminalOptionShortcutAction,
  type MacOptionAsAlt
} from './terminal-option-shortcut-policy'
import type { OptionKeyLocationState } from '../../lib/keyboard-layout/option-key-location-state'
import type { TerminalOptionKittyRelease } from './terminal-option-kitty-release'

export type { MacOptionAsAlt } from './terminal-option-shortcut-policy'

export type TerminalShortcutEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  getModifierState?: (key: string) => boolean
}

// Shared close-chord predicate: the terminal pane (L3) and the floating panel's focused-terminal
// branch (L2) both treat terminal.closePane OR a terminal-scope tab.close as "close the active
// pane," so the two layers can't diverge. Callers pass the options each binding needs —
// terminal.closePane is context-free; tab.close is scoped to the terminal surface.
export function isTerminalPaneCloseChord(
  event: KeybindingInput,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  closePaneOptions?: KeybindingMatchOptions,
  tabCloseOptions?: KeybindingMatchOptions
): boolean {
  return (
    keybindingMatchesAction('terminal.closePane', event, platform, keybindings, closePaneOptions) ||
    keybindingMatchesAction('tab.close', event, platform, keybindings, tabCloseOptions)
  )
}

export type TerminalShortcutAction =
  | { type: 'copySelection' }
  | { type: 'selectAll' }
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
  | {
      type: 'sendInput'
      data: string
      optionKittyRelease?: TerminalOptionKittyRelease
      consumeOptionKeyUp?: boolean
    }
  | { type: 'trackNativeOptionDeadKey' }
  | { type: 'switchInputSource' }

/**
 * Resolves terminal keyboard events before xterm receives them, centralizing
 * Orca shortcuts and terminal byte fallbacks in one platform-aware policy.
 */
export function resolveTerminalShortcutAction(
  event: TerminalShortcutEvent,
  isMac: boolean,
  macOptionAsAlt: MacOptionAsAlt = 'false',
  optionKeyLocations: OptionKeyLocationState = 0,
  isWindows: boolean = false,
  keybindings?: KeybindingOverrides,
  // Why: lazy so local ConPTY lookup runs only for Ctrl+Arrow and Ctrl+Enter.
  isLocalWindowsConptyPane?: () => boolean,
  // Why: exact flags distinguish ordinary kitty negotiation from report-all mode.
  getKittyKeyboardFlagsActivePane?: () => number,
  // Why: composition is the difference between event.key and the current layout with Option absent.
  layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined,
  // Why: lazy so agent-state lookup for the pane's Windows encoding runs only on Shift+Enter, not every keystroke.
  getWindowsShiftEnterEncoding?: () => WindowsShiftEnterEncoding,
  // Why: keybindings follow the client OS, but byte protocols follow the PTY host — they differ for macOS clients on Windows runtimes.
  isWindowsTerminalHost: () => boolean = () => isWindows,
  // Why: gates the tab.close pane-close alias — under terminal-first a remapped tab.close yields to the shell (terminal.closePane, scope terminal, still closes).
  terminalShortcutPolicy: TerminalShortcutPolicy = 'orca-first',
  // Why: query-only Droid/Grok consumers need CSI-u even when the live kitty flags remain inactive.
  hasCtrlEnterCsiUAuthority?: () => boolean
): TerminalShortcutAction | null {
  const platform: NodeJS.Platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux'
  // Why: an Option chord composes from the unshifted layer, so shortcut matching asks for the base character.
  const baseLayoutCharacterForCode: LayoutCharacterLookup | undefined = layoutCharacterForCode
    ? (code) => layoutCharacterForCode(code, false)
    : undefined
  const matchesAction = (actionId: Parameters<typeof keybindingMatchesAction>[0]): boolean =>
    keybindingMatchesAction(actionId, event, platform, keybindings, {
      layoutCharacterForCode: baseLayoutCharacterForCode
    })

  // Why: capture this chord even on repeat without blocking the OS default input-source switch.
  if (matchesAction('terminal.switchInputSource')) {
    return { type: 'switchInputSource' }
  }

  // Why: held select-all keydowns must remain claimed until keyup so Kitty
  // event reporting cannot encode their repeat or release into the PTY.
  if (matchesAction('terminal.selectAll')) {
    return { type: 'selectAll' }
  }

  if (!event.repeat) {
    if (matchesAction('terminal.copySelection')) {
      return { type: 'copySelection' }
    }

    if (matchesAction('terminal.search')) {
      return { type: 'toggleSearch' }
    }

    if (matchesAction('terminal.clear')) {
      return { type: 'clearActivePane' }
    }

    if (matchesAction('terminal.focusPreviousPane')) {
      return { type: 'focusPane', direction: 'previous' }
    }

    if (matchesAction('terminal.focusNextPane')) {
      return { type: 'focusPane', direction: 'next' }
    }

    if (matchesAction('terminal.equalizePaneSizes')) {
      return { type: 'equalizePaneSizes' }
    }

    if (matchesAction('terminal.expandPane')) {
      return { type: 'toggleExpandActivePane' }
    }

    if (matchesAction('terminal.setTitle')) {
      return { type: 'setTitle' }
    }

    if (matchesAction('terminal.clearPaneTitle')) {
      return { type: 'clearPaneTitle' }
    }

    // Why: recognize the active tab.close binding as a pane-close alias too, so a user who remaps
    // tab.close alone still closes the focused split pane (never the whole tab); L2 always defers to us.
    if (
      isTerminalPaneCloseChord(
        event,
        platform,
        keybindings,
        { layoutCharacterForCode: baseLayoutCharacterForCode },
        {
          context: 'terminal',
          terminalShortcutPolicy,
          layoutCharacterForCode: baseLayoutCharacterForCode
        }
      )
    ) {
      return { type: 'closeActivePane' }
    }

    if (matchesAction('terminal.splitRight')) {
      return { type: 'splitActivePane', direction: 'vertical' }
    }

    if (matchesAction('terminal.splitDown')) {
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
    const canSendCsiU = hasTrustedWindowsCsiU || (getKittyKeyboardFlagsActivePane?.() ?? 0) > 0
    return { type: 'sendInput', data: canSendCsiU ? '\x1b[13;2u' : '\x1b\r' }
  }

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === 'Enter'
  ) {
    const localWindowsConpty = isLocalWindowsConptyPane?.() === true
    // Why: preserve query-only TUI chords elsewhere; local ConPTY shells require negotiation or trusted consumer evidence (#12329).
    const canSendCsiU =
      !localWindowsConpty ||
      (getKittyKeyboardFlagsActivePane?.() ?? 0) > 0 ||
      hasCtrlEnterCsiUAuthority?.() === true
    return {
      type: 'sendInput',
      data: canSendCsiU ? '\x1b[13;5u' : '\r'
    }
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
    if ((getKittyKeyboardFlagsActivePane?.() ?? 0) > 0) {
      return null
    }
    return { type: 'sendInput', data: '\x1b\x7f' }
  }

  if (
    !event.metaKey &&
    !event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    event.code?.startsWith('Numpad') !== true &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    // Why: a kitty-protocol TUI binds alt+arrow via xterm's native CSI 1;3D/C; \eb/\ef would reach it as alt+b/f.
    if ((getKittyKeyboardFlagsActivePane?.() ?? 0) > 0) {
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

  const optionAction = resolveTerminalOptionShortcutAction(event, {
    isMac,
    macOptionAsAlt,
    optionKeyLocations,
    getKittyKeyboardFlags: () => getKittyKeyboardFlagsActivePane?.() ?? 0,
    layoutCharacterForCode
  })
  if (optionAction) {
    return optionAction
  }

  return null
}
