import {
  KEYBINDING_DEFINITIONS,
  getEffectiveKeybindingsForDefinition,
  isDigitIndexActionId,
  keybindingIsActiveInContext,
  parseKeybinding,
  platformModifiers,
  resolveModifierToken,
  type KeybindingDefinition,
  type KeybindingOverrides,
  type KeybindingScope,
  type TerminalShortcutPolicy
} from './keybindings'
import {
  MAC_SPECIAL_KEYS,
  NS_COMMAND,
  NS_CONTROL,
  NS_OPTION,
  NS_SHIFT
} from './native-terminal-keys'

// A chord the native terminal hands to Orca instead of encoding it. Layout-dependent keys
// (letters, digits, punctuation) match by their unmodified character; named keys by keyCode;
// a modifier key's own code marks a double-tap binding whose taps the native view reports.
export type NativeTerminalForwardedChord = {
  keyCode: number
  character: string
  modifierFlags: number
}

// Scopes whose shortcut handlers still run while a terminal pane holds the keyboard.
const TERMINAL_FOCUS_SCOPES: ReadonlySet<KeybindingScope> = new Set(['global', 'tabs', 'terminal'])

const PUNCTUATION_CHARACTERS: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`'
}

const ARROW_ACCELERATORS: Readonly<Record<string, string>> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down'
}

// Only keys the main process can replay (MAC_SPECIAL_KEYS or a character) become chords.
function chordKeys(key: string): { keyCode: number; character: string }[] {
  if (/^[A-Z0-9]$/.test(key)) {
    return [{ keyCode: -1, character: key.toLowerCase() }]
  }
  const punctuation = PUNCTUATION_CHARACTERS[key]
  if (punctuation) {
    return [{ keyCode: -1, character: punctuation }]
  }
  const accelerator = ARROW_ACCELERATORS[key] ?? key
  return Object.entries(MAC_SPECIAL_KEYS)
    .filter(([, name]) => name === accelerator)
    .map(([keyCode]) => ({ keyCode: Number(keyCode), character: '' }))
}

// Left and right keys (Carbon kVK_*) of each modifier a double-tap binding can name.
const DOUBLE_TAP_KEYS = {
  shift: { keyCodes: [0x38, 0x3c], modifierFlags: NS_SHIFT },
  control: { keyCodes: [0x3b, 0x3e], modifierFlags: NS_CONTROL },
  alt: { keyCodes: [0x3a, 0x3d], modifierFlags: NS_OPTION },
  meta: { keyCodes: [0x37, 0x36], modifierFlags: NS_COMMAND }
} as const

function bindingChords(
  definition: KeybindingDefinition,
  binding: string
): NativeTerminalForwardedChord[] {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return []
  }
  if (parsed.doubleTapModifier) {
    const { keyCodes, modifierFlags } =
      DOUBLE_TAP_KEYS[resolveModifierToken(parsed.doubleTapModifier, 'darwin')]
    return keyCodes.map((keyCode) => ({ keyCode, character: '', modifierFlags }))
  }
  const modifiers = platformModifiers(parsed, 'darwin')
  // Command chords already go to Orca wholesale.
  if (modifiers.meta) {
    return []
  }
  const modifierFlags =
    (modifiers.shift ? NS_SHIFT : 0) |
    (modifiers.control ? NS_CONTROL : 0) |
    (modifiers.alt ? NS_OPTION : 0)
  const keys = isDigitIndexActionId(definition.id)
    ? ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    : [parsed.key]
  const flagVariants =
    // Why: the held Ctrl+Tab switcher claims Ctrl+Shift+Tab too, to step backwards.
    definition.id === 'tab.previousRecent' && parsed.key === 'Tab' && modifierFlags === NS_CONTROL
      ? [modifierFlags, modifierFlags | NS_SHIFT]
      : [modifierFlags]
  return keys.flatMap((key) =>
    chordKeys(key).flatMap((chordKey) =>
      flagVariants.map((flags) => ({ ...chordKey, modifierFlags: flags }))
    )
  )
}

// The non-Command chords Orca's shortcut handlers claim while a terminal is focused on macOS,
// for the native view to hand over instead of encoding them for the PTY.
export function buildNativeTerminalForwardedChords(options: {
  overrides: KeybindingOverrides | undefined
  terminalShortcutPolicy: TerminalShortcutPolicy | undefined
  definitions?: readonly KeybindingDefinition[]
}): NativeTerminalForwardedChord[] {
  const matchOptions = {
    context: 'terminal',
    terminalShortcutPolicy: options.terminalShortcutPolicy
  } as const
  const chords = new Map<string, NativeTerminalForwardedChord>()
  for (const definition of options.definitions ?? KEYBINDING_DEFINITIONS) {
    if (
      !TERMINAL_FOCUS_SCOPES.has(definition.scope) ||
      !keybindingIsActiveInContext(definition, matchOptions)
    ) {
      continue
    }
    for (const binding of getEffectiveKeybindingsForDefinition(
      definition,
      'darwin',
      options.overrides
    )) {
      for (const chord of bindingChords(definition, binding)) {
        chords.set(`${chord.keyCode}:${chord.character}:${chord.modifierFlags}`, chord)
      }
    }
  }
  return [...chords.values()]
}

export function isNativeTerminalForwardedChord(
  value: unknown
): value is NativeTerminalForwardedChord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'keyCode' in value &&
    Number.isInteger(value.keyCode) &&
    'character' in value &&
    typeof value.character === 'string' &&
    value.character.length <= 1 &&
    'modifierFlags' in value &&
    Number.isInteger(value.modifierFlags)
  )
}
