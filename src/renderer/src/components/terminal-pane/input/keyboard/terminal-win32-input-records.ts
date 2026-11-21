// Set-1 scan codes for the printable keys AltGr can modify; ConPTY rebuilds KEY_EVENT_RECORDs from them.
const SCAN_CODE_BY_KEY_CODE: Record<string, number> = {
  Backquote: 0x29,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backslash: 0x2b,
  IntlBackslash: 0x56,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  IntlRo: 0x73,
  IntlYen: 0x7d,
  Space: 0x39
}

// dwControlKeyState bits from wincon.h.
const RIGHT_ALT_PRESSED = 0x01
const LEFT_ALT_PRESSED = 0x02
const LEFT_CTRL_PRESSED = 0x08
const SHIFT_PRESSED = 0x10
const CAPSLOCK_ON = 0x80

export type Win32InputRecordKeyEvent = {
  type: string
  key: string
  code: string
  keyCode: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  getModifierState?: (key: string) => boolean
}

export function isAltGrTextKey(event: Win32InputRecordKeyEvent): boolean {
  // Why: Chromium on Windows reports AltGr as Ctrl+Alt with the produced character as `key`.
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.metaKey &&
    event.keyCode !== 229 &&
    [...event.key].length === 1 &&
    event.key >= ' '
  )
}

function encodeRecord(event: Win32InputRecordKeyEvent, keyDown: boolean): string {
  const altGraph = event.getModifierState?.('AltGraph') === true
  let controlKeyState = 0
  if (event.ctrlKey) {
    controlKeyState |= LEFT_CTRL_PRESSED
  }
  if (event.altKey) {
    controlKeyState |= altGraph ? RIGHT_ALT_PRESSED : LEFT_ALT_PRESSED
  }
  if (event.shiftKey) {
    controlKeyState |= SHIFT_PRESSED
  }
  if (event.getModifierState?.('CapsLock') === true) {
    controlKeyState |= CAPSLOCK_ON
  }
  const scanCode = SCAN_CODE_BY_KEY_CODE[event.code] ?? 0
  const unicodeChar = event.key.codePointAt(0) ?? 0
  return `\x1b[${event.keyCode};${scanCode};${unicodeChar};${keyDown ? 1 : 0};${controlKeyState};1_`
}

/** Encode an AltGr text key as a win32 input record (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`) for apps that set DECSET 9001.
 * Returns null for every other key so xterm keeps its normal encoding. */
export function encodeWin32InputRecordForAltGr(event: Win32InputRecordKeyEvent): string | null {
  if ((event.type !== 'keydown' && event.type !== 'keyup') || !isAltGrTextKey(event)) {
    return null
  }
  return encodeRecord(event, event.type === 'keydown')
}

/** Encode the key-up of a key whose key-down was already sent as a record, even after AltGr was released first. */
export function encodeWin32InputRecordRelease(event: Win32InputRecordKeyEvent): string {
  return encodeRecord(event, false)
}
