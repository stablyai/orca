import { keybindingMatchesInput } from '../../../../shared/keybindings'
import { isHangulJamoKeyText } from './hangul-jamo-key'
import { getLayoutBaseCharacterForCode } from '../../lib/keyboard-layout/layout-base-character'
import { isTerminalImeCandidateSelectionKeyEvent } from './terminal-ime-candidate-key-release-guard'

/** Bypass Kitty encoding before it cancels clipboard/native-menu keydowns; cancellation suppresses Chromium’s copy event and OS bindings. */

export type XtermBypassEvent = {
  type: string
  key: string
  code?: string
  keyCode?: number
  isComposing?: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type XtermBypassOptions = {
  isMac: boolean
  kittyKeyboardFlags?: number
  /** On Windows/Linux, Ctrl+C copies only with a selection; otherwise it must reach SIGINT. */
  hasSelection: boolean
  /** iOS/iPadOS WebKit may compose CJK through field rewrites without a composition session; see terminal-ios-hangul-preedit.ts. */
  isIosWeb?: boolean
}

export type XtermImeKeyboardOptions = {
  compositionActive: boolean
  /** Candidate keys remain IME-owned during composition and a short post-compositionend window. */
  candidateKeyGuardActive: boolean
  /** True when the pending-release guard already matched this specific event. */
  pendingCandidateKeyReleaseActive: boolean
  // Require explicit macOS policy so fallback 229 suppression cannot swallow the first key after an input-source switch.
  isMac: boolean
  // Keep Windows preedit-diff suppression separate from macOS/Linux standalone 229 commits.
  isLinux: boolean
}

export const TERMINAL_INTERRUPT_INPUT = '\x03'
const TERMINAL_MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])
const TERMINAL_IME_OWNED_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp'
])

function isSingleNonAsciiPrintableText(key: string): boolean {
  const chars = Array.from(key)
  if (chars.length !== 1) {
    return false
  }
  const codePoint = chars[0].codePointAt(0)
  return codePoint !== undefined && codePoint >= 0x80
}

function isXtermHandledKeyEvent(type: string): boolean {
  return type === 'keydown' || type === 'keyup'
}

// iOS field edits need native printable-key defaults; bypass keypress too so xterm cannot duplicate the preedit commit.
export function shouldBypassXtermForIosTextEdit(
  event: XtermBypassEvent,
  isIosWeb: boolean
): boolean {
  if (!isIosWeb || event.ctrlKey || event.metaKey || event.altKey) {
    return false
  }
  if (event.isComposing === true) {
    // Real composition sessions stay with xterm’s CompositionHelper.
    return false
  }
  if (!isXtermHandledKeyEvent(event.type) && event.type !== 'keypress') {
    return false
  }
  // Only jamo has a downstream preedit sender; claiming Cyrillic/kana would swallow every path to the PTY.
  return isHangulJamoKeyText(event.key)
}

export function shouldSuppressTerminalImeKeyboardEvent(
  event: XtermBypassEvent,
  options: XtermImeKeyboardOptions
): boolean {
  const {
    compositionActive,
    candidateKeyGuardActive,
    pendingCandidateKeyReleaseActive,
    isMac,
    isLinux
  } = options
  const suppressCandidateKey =
    isLinux &&
    (pendingCandidateKeyReleaseActive ||
      (candidateKeyGuardActive && isTerminalImeCandidateSelectionKeyEvent(event)))
  if (event.type === 'keypress') {
    // A bypassed keydown still fires native keypress; suppress IME-owned selectors there too.
    return suppressCandidateKey
  }
  if (!isXtermHandledKeyEvent(event.type)) {
    return false
  }
  // Suppress composing/Process keys, but let bare macOS/Linux 229 schedule commit diffs; Windows retains suppression for its preedit race.
  const passesStandalone229Keydown = isMac || isLinux
  const passesIdleComposing229Keydown =
    event.type === 'keydown' &&
    event.keyCode === 229 &&
    event.isComposing === true &&
    !compositionActive &&
    passesStandalone229Keydown
  return (
    (event.isComposing === true && !passesIdleComposing229Keydown) ||
    (event.keyCode === 229 &&
      (event.type !== 'keydown' || compositionActive || !passesStandalone229Keydown)) ||
    (compositionActive && TERMINAL_IME_OWNED_KEYS.has(event.key)) ||
    suppressCandidateKey
  )
}

export function shouldPreventDefaultTerminalImeCandidateKey(
  event: XtermBypassEvent,
  options: XtermImeKeyboardOptions
): boolean {
  // Bypass alone leaves native defaults; prevent trailing candidate keys from leaking through a later 229 diff.
  // While a composition session is live, the candidate keydown is the IME's commit trigger: preventing it
  // also cancels the browser-generated keypress that carries the committed character (#30334).
  return (
    event.type === 'keydown' &&
    options.isLinux &&
    options.candidateKeyGuardActive &&
    !options.compositionActive &&
    isTerminalImeCandidateSelectionKeyEvent(event)
  )
}

/** Arm the pending release for every guarded candidate keydown, preventDefault or not:
 *  a held Space or digit can repeat past the guard window, and the armed release keeps
 *  those repeats owned until the key comes up. */
export function shouldArmTerminalImePendingCandidateKeyRelease(
  event: XtermBypassEvent,
  options: XtermImeKeyboardOptions
): boolean {
  return (
    event.type === 'keydown' &&
    options.isLinux &&
    options.candidateKeyGuardActive &&
    isTerminalImeCandidateSelectionKeyEvent(event)
  )
}

/**
 * A logical key a Latin layout could have produced. Only then is `key` authoritative:
 * Dvorak moving `c` elsewhere is a real remap and must be honoured.
 */
function isLatinLetterKey(normalizedKey: string): boolean {
  return normalizedKey.length === 1 && normalizedKey >= 'a' && normalizedKey <= 'z'
}

function isTerminalInterruptCKey(event: XtermBypassEvent): boolean {
  const normalizedKey = event.key.toLowerCase()
  if (isLatinLetterKey(normalizedKey)) {
    return normalizedKey === 'c'
  }
  // For non-Latin IME glyphs, consult the Latin base layout so remapped physical KeyC does not become a false interrupt.
  const layoutBaseKey = event.code
    ? getLayoutBaseCharacterForCode(event.code)?.toLowerCase()
    : undefined
  if (layoutBaseKey !== undefined && isLatinLetterKey(layoutBaseKey)) {
    return layoutBaseKey === 'c'
  }
  // True non-Latin maps cannot name logical C; use terminal physical-position fallback, also for empty/Unidentified keys.
  return event.code === 'KeyC' || event.keyCode === 67
}

function isPlainCtrlC(event: XtermBypassEvent): boolean {
  return (
    isTerminalInterruptCKey(event) &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

function matchesClipboardBinding(
  binding: string,
  event: XtermBypassEvent,
  platform: NodeJS.Platform
): boolean {
  return keybindingMatchesInput(binding, event, platform)
}

/**
 * On macOS an unselected Cmd+C belongs to an app that negotiated Kitty keyboard
 * reporting: apps like Codex capture the mouse, so their highlight is never an
 * xterm selection. Without negotiation, unselected Cmd+C still sends nothing.
 */
export function isAppOwnedCopyChord(
  event: XtermBypassEvent,
  options: Pick<XtermBypassOptions, 'isMac' | 'hasSelection' | 'kittyKeyboardFlags'>
): boolean {
  return (
    options.isMac &&
    !options.hasSelection &&
    (options.kittyKeyboardFlags ?? 0) !== 0 &&
    matchesClipboardBinding('Mod+C', event, 'darwin')
  )
}

export function shouldHandleTerminalInterruptKeyboardEvent(
  event: XtermBypassEvent,
  options: XtermBypassOptions
): boolean {
  if (!isXtermHandledKeyEvent(event.type) || !isPlainCtrlC(event)) {
    return false
  }

  if (options.isMac) {
    return true
  }

  return !options.hasSelection
}

export function shouldSuppressTerminalInterruptKeyup(event: XtermBypassEvent): boolean {
  return (
    event.type === 'keyup' &&
    isTerminalInterruptCKey(event) &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function shouldSuppressTerminalModifierKeyboardEvent(event: XtermBypassEvent): boolean {
  return isXtermHandledKeyEvent(event.type) && TERMINAL_MODIFIER_KEYS.has(event.key)
}

/** Bypass xterm encoding for native clipboard/menu handling or layout-aware text events. */
export function shouldBypassXtermKeyboardEvent(
  event: XtermBypassEvent,
  options: XtermBypassOptions
): boolean {
  if (shouldBypassXtermForIosTextEdit(event, options.isIosWeb === true)) {
    return true
  }
  if (!isXtermHandledKeyEvent(event.type)) {
    return false
  }

  const { isMac, hasSelection } = options
  const platformModifierHeld = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey

  if (event.defaultPrevented && platformModifierHeld) {
    // Already-handled app shortcuts must not also reach the shell when propagation continues.
    return true
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    isSingleNonAsciiPrintableText(event.key)
  ) {
    // Kitty derives Latin shifted codes from physical keys; use Chromium layout text and suppress release CSI-u too.
    return true
  }

  if (isAppOwnedCopyChord(event, options)) {
    return false
  }

  if (isMac) {
    // Electron consumes other Cmd chords earlier; web paste still needs Chromium’s native event.
    return (
      matchesClipboardBinding('Mod+C', event, 'darwin') ||
      matchesClipboardBinding('Mod+V', event, 'darwin')
    )
  }

  // Windows/Linux: standard clipboard bindings bubble; Ctrl+C only bubbles
  // with a selection (otherwise it's SIGINT and must reach the shell).
  if (matchesClipboardBinding('Ctrl+Shift+C', event, 'linux')) {
    return true
  }
  if (matchesClipboardBinding('Ctrl+C', event, 'linux') && hasSelection) {
    return true
  }
  if (
    matchesClipboardBinding('Ctrl+V', event, 'linux') ||
    matchesClipboardBinding('Ctrl+Shift+V', event, 'linux')
  ) {
    return true
  }
  if (matchesClipboardBinding('Shift+Insert', event, 'linux')) {
    return true
  }

  return false
}
