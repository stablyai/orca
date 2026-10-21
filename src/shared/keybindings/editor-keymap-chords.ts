import type {
  KeybindingInput,
  KeybindingOverrides,
  KeybindingActionId,
  ParsedKeybinding
} from './types'
import { parseKeybinding } from './parser'
import { keyMatches, modifierStateMatches, platformModifiers } from './matching-key'
import { getEffectiveKeybindingsForAction } from './effective'

/**
 * Chords the Emacs editor preset owns: every modified key monaco-emacs binds plus Orca's additions
 * (`C-x h`, `C-?`, `C-M-_`, `S-C-z`). `Ctrl` is the physical Control key on every platform (never `Mod`), because
 * Emacs chords are Control chords on macOS too. While an Emacs editor has focus, Orca yields these
 * to the editor instead of running app shortcuts such as Ctrl+P, Ctrl+W or Ctrl+B on Linux/Windows.
 */
export const EMACS_EDITOR_CHORDS: readonly string[] = [
  ...[...'ABDEFGHKLMNOPQRSTUVWXYZ'].map((letter) => `Ctrl+${letter}`),
  'Ctrl+Space',
  'Ctrl+Slash',
  'Ctrl+Backspace',
  ...[...'BDFGRVWY'].map((letter) => `Alt+${letter}`),
  'Alt+Slash',
  'Alt+Semicolon',
  'Alt+Backspace',
  'Alt+Delete',
  'Ctrl+Alt+N',
  'Ctrl+Shift+Underscore',
  'Ctrl+Shift+2',
  'Ctrl+Shift+Backspace',
  'Ctrl+Shift+Z',
  'Ctrl+Shift+Slash',
  'Ctrl+Alt+Shift+Minus',
  'Alt+Shift+Period',
  'Alt+Shift+Comma',
  'Alt+Shift+5'
]

const PARSED_EMACS_EDITOR_CHORDS: readonly ParsedKeybinding[] = EMACS_EDITOR_CHORDS.flatMap(
  (chord) => {
    const parsed = parseKeybinding(chord)
    return parsed ? [parsed] : []
  }
)

function chordIdentity(parsed: ParsedKeybinding, platform: NodeJS.Platform): string {
  const modifiers = platformModifiers(parsed, platform)
  return [
    modifiers.meta ? 'Meta' : '',
    modifiers.control ? 'Control' : '',
    modifiers.alt ? 'Alt' : '',
    modifiers.shift ? 'Shift' : '',
    parsed.key
  ].join('+')
}

/** True when the pressed key is a chord the Emacs editor preset owns. */
export function isEmacsEditorChordInput(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  if (input.doubleTapModifier !== undefined) {
    return false
  }
  return PARSED_EMACS_EDITOR_CHORDS.some(
    (parsed) =>
      modifierStateMatches(parsed, input, platform) &&
      keyMatches(parsed.key, input, parsed, platform)
  )
}

/** True when a binding string resolves, on this platform, to a chord the Emacs editor preset owns. */
export function isEmacsEditorChordBinding(binding: string, platform: NodeJS.Platform): boolean {
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier) {
    return false
  }
  const identity = chordIdentity(parsed, platform)
  return PARSED_EMACS_EDITOR_CHORDS.some((chord) => chordIdentity(chord, platform) === identity)
}

/** True when any effective binding of the action is yielded while an Emacs editor has focus. */
export function keybindingYieldsToEmacsEditor(
  actionId: KeybindingActionId,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): boolean {
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).some((binding) =>
    isEmacsEditorChordBinding(binding, platform)
  )
}
