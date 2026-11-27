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

function encodeSoftKeyboardKey(key: SoftKeyboardKey, kittyKeyboardFlags: number): string {
  if (key === 'Enter') {
    return '\r'
  }
  const plain = key === 'Backspace' ? '\x7f' : '\x1b[3~'
  if (!kittyReportsAllKeysAsEscapeCodes(kittyKeyboardFlags)) {
    return plain
  }
  // CSI 127 u is the kitty spelling of Backspace; Delete has no dedicated encoding and stays 3~.
  const codePoint = key === 'Backspace' ? 127 : 3
  const press = `\x1b[${codePoint}u`
  return (kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) === 0
    ? press
    : `${press}\x1b[${codePoint};1:3u`
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
