// AppKit key facts shared by the native terminal's chord forwarding (renderer) and its replay
// into the web contents (main).

// NSEventModifierFlags bits (AppKit).
export const NS_SHIFT = 1 << 17
export const NS_CONTROL = 1 << 18
export const NS_OPTION = 1 << 19
export const NS_COMMAND = 1 << 20

// macOS virtual key codes (Carbon kVK_*) for keys whose characters are not their accelerator name.
export const MAC_SPECIAL_KEYS: Readonly<Record<number, string>> = {
  0x24: 'Enter',
  0x4c: 'Enter',
  0x30: 'Tab',
  0x31: 'Space',
  0x33: 'Backspace',
  0x35: 'Escape',
  0x75: 'Delete',
  0x73: 'Home',
  0x77: 'End',
  0x74: 'PageUp',
  0x79: 'PageDown',
  0x7b: 'Left',
  0x7c: 'Right',
  0x7d: 'Down',
  0x7e: 'Up',
  0x7a: 'F1',
  0x78: 'F2',
  0x63: 'F3',
  0x76: 'F4',
  0x60: 'F5',
  0x61: 'F6',
  0x62: 'F7',
  0x64: 'F8',
  0x65: 'F9',
  0x6d: 'F10',
  0x67: 'F11',
  0x6f: 'F12',
  // Modifier keys, replayed on release after a forwarded chord.
  0x38: 'Shift',
  0x3c: 'Shift',
  0x3b: 'Control',
  0x3e: 'Control',
  0x3a: 'Alt',
  0x3d: 'Alt',
  0x37: 'Meta',
  0x36: 'Meta'
}
