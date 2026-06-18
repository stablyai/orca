const HOTKEY_MODIFIERS = new Set([
  'alt',
  'cmd',
  'cmdorctrl',
  'command',
  'commandorcontrol',
  'control',
  'ctrl',
  'meta',
  'option',
  'shift',
  'super',
  'win'
])

const HOTKEY_HINT =
  'Hotkey requires a modifier and one key, e.g. CmdOrCtrl+A. Use press-key for a single key.'
const PRESS_KEY_HINT =
  'Press-key accepts one key only, e.g. Return, Escape, Tab, or +. Use hotkey for modifier combinations.'

export function computerUseHotkeyValidationMessage(key: string): string | null {
  const parts = key.split('+').map((part) => part.trim())
  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return HOTKEY_HINT
  }

  let keyPartCount = 0
  for (const part of parts) {
    if (!HOTKEY_MODIFIERS.has(normalizeHotkeyPart(part))) {
      keyPartCount += 1
    }
  }

  if (keyPartCount !== 1) {
    return HOTKEY_HINT
  }

  return null
}

export function computerUsePressKeyValidationMessage(key: string): string | null {
  const trimmed = key.trim()
  if (trimmed.length === 0) {
    return PRESS_KEY_HINT
  }
  if (trimmed !== '+' && trimmed.includes('+')) {
    return PRESS_KEY_HINT
  }
  return null
}

function normalizeHotkeyPart(part: string): string {
  return part.toLowerCase().replace(/[\s_-]/g, '')
}
