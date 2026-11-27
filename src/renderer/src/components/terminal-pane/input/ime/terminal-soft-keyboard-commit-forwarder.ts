import type { IDisposable } from '@xterm/xterm'
import {
  KITTY_REPORT_EVENT_TYPES,
  kittyReportsAllKeysAsEscapeCodes
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'

// Android soft keyboards (Samsung Keyboard, Gboard) edit the proxy through a keyCode 229 keydown
// plus beforeinput/input rather than through encodable keydowns (#50460). Two separate gaps follow.
//
// The keydown has to be kept away from xterm. Its 229 keyCode carries no text and no key of its
// own — xterm would handle it exactly like a desktop IME's Process key and send nothing — but it
// arms the composed-input gate first, and that gate then drops the `insertText` carrying the
// letter. Keeping the keydown off xterm leaves the gate clear, so xterm forwards the commit.
//
// The delete family has no xterm path at all: a Backspace reported this way arrives as
// `deleteContentBackward` with no key xterm can name, so it is pressed on the page here.
//
// The desktop IME paths deliberately do not run on Android: the native text forwarder installs on
// macOS/Linux only, and Android user agents are excluded from the Linux IME policy so a 229
// keydown is left to xterm rather than suppressed (terminal-pane-pane-input.ts).

type SoftKeyboardKey = 'Backspace' | 'Delete' | 'Enter'

const FUNCTIONAL_KEY_INPUT_TYPES: ReadonlyMap<string, SoftKeyboardKey> = new Map([
  ['deleteContentBackward', 'Backspace'],
  ['deleteContentForward', 'Delete'],
  ['insertLineBreak', 'Enter'],
  ['insertParagraph', 'Enter']
])

/** How long a claimed 229 press owns its commit. A soft keyboard commits within the same gesture. */
const SOFT_KEYBOARD_CLAIM_WINDOW_MS = 500

export type TerminalSoftKeyboardInputRepair = IDisposable

export function isAndroidClient(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

/**
 * A functional key's spelling in the Kitty protocol, with its release when event reporting is on.
 *
 * The three keys do not share one rule (kitty's `encode_function_key` is the reference):
 * - Enter, Tab and Backspace keep `\r`, `\t` and `0x7f` unless every key is reported as an escape
 *   code, where they become `CSI 13 u`, `CSI 9 u` and `CSI 127 u`.
 * - Delete is `CSI 3 ~` in every mode. It has no CSI-u form, and its release keeps the `~`.
 * - Enter, Tab and Backspace have no release unless every key is reported as an escape code;
 *   Delete has one whenever event types are on.
 *
 * Soft keyboards leave Shift down after shift-typed text, so Shift is omitted rather than
 * reported as a held modifier.
 */
function encodeSoftKeyboardKey(key: SoftKeyboardKey, kittyKeyboardFlags: number): string {
  if (kittyKeyboardFlags === 0) {
    return LEGACY_SOFT_KEYBOARD_BYTES[key]
  }
  const reportsAllKeys = kittyReportsAllKeysAsEscapeCodes(kittyKeyboardFlags)
  const reportsReleases = (kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) !== 0
  // Delete owes a release whenever event types are on; the other two only under report-all.
  const owesRelease = reportsReleases && (key === 'Delete' || reportsAllKeys)
  const press = encodeSoftKeyboardKeyEvent(key, 'press', reportsAllKeys)
  return owesRelease ? `${press}${encodeSoftKeyboardKeyEvent(key, 'release', reportsAllKeys)}` : press
}

const LEGACY_SOFT_KEYBOARD_BYTES: Readonly<Record<SoftKeyboardKey, string>> = {
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Enter: '\r'
}

const KITTY_FUNCTIONAL_CODES: Readonly<Record<SoftKeyboardKey, { codePoint: number; trailer: 'u' | '~' }>> = {
  Backspace: { codePoint: 127, trailer: 'u' },
  Delete: { codePoint: 3, trailer: '~' },
  Enter: { codePoint: 13, trailer: 'u' }
}

function encodeSoftKeyboardKeyEvent(
  key: SoftKeyboardKey,
  type: 'press' | 'release',
  reportsAllKeys: boolean
): string {
  if (!reportsAllKeys && key !== 'Delete') {
    // Without report-all these keys are plain legacy bytes, which carry no release at all.
    return type === 'press' ? LEGACY_SOFT_KEYBOARD_BYTES[key] : ''
  }
  const { codePoint, trailer } = KITTY_FUNCTIONAL_CODES[key]
  // A release always carries an event-type field, so the modifier slot is written even when empty.
  return type === 'press' ? `\x1b[${codePoint}${trailer}` : `\x1b[${codePoint};1:3${trailer}`
}

export function installTerminalSoftKeyboardInputRepair(args: {
  terminalElement: HTMLElement | null | undefined
  isComposing: () => boolean
  sendInput: (data: string) => void
  getKittyKeyboardFlags?: () => number
}): TerminalSoftKeyboardInputRepair {
  const terminalElement = args.terminalElement
  if (!terminalElement) {
    return { dispose: () => undefined }
  }

  let claimAt: number | null = null

  // Capture on the terminal element: the helper textarea is a descendant, so this runs before
  // xterm's own keydown listener on the textarea regardless of registration order.
  const repairKeyDown = (event: KeyboardEvent): void => {
    // 229 is the only signal an Android soft keyboard gives before it edits the field. Every other
    // keydown carries a real key that xterm already encodes, so it is left alone.
    if (
      event.keyCode !== 229 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      args.isComposing()
    ) {
      claimAt = null
      return
    }
    claimAt = Date.now()
    event.stopImmediatePropagation()
    event.preventDefault()
  }

  const repairEdit = (event: Event): void => {
    if (!(event instanceof InputEvent) || event.inputType === 'insertCompositionText') {
      return
    }
    const owned = claimAt !== null && Date.now() - claimAt <= SOFT_KEYBOARD_CLAIM_WINDOW_MS
    if (!owned) {
      return
    }
    const softKey = FUNCTIONAL_KEY_INPUT_TYPES.get(event.inputType)
    claimAt = null
    if (softKey === undefined) {
      // An ordinary typed character. Its keydown never reached xterm, so the gate is clear and
      // xterm's own input handler forwards the commit — nothing to do here.
      return
    }
    args.sendInput(encodeSoftKeyboardKey(softKey, args.getKittyKeyboardFlags?.() ?? 0))
    // Cancel the IME's own edit so the proxy keeps matching what the terminal received; otherwise a
    // later Backspace would address text the terminal never had.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.target instanceof HTMLTextAreaElement) {
      event.target.value = ''
    }
  }

  terminalElement.addEventListener('keydown', repairKeyDown, true)
  terminalElement.addEventListener('beforeinput', repairEdit, true)
  terminalElement.addEventListener('input', repairEdit, true)

  return {
    dispose: () => {
      claimAt = null
      terminalElement.removeEventListener('keydown', repairKeyDown, true)
      terminalElement.removeEventListener('beforeinput', repairEdit, true)
      terminalElement.removeEventListener('input', repairEdit, true)
    }
  }
}
