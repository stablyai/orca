import type {
  CanonicalChord,
  EffectiveKeymap,
  KeybindingActionId,
  KeybindingPlatform
} from './keybinding-types'

const KEY_LABELS: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  space: 'Space',
  '+': '+',
  '-': '-'
}

export function formatCanonicalChordLabel(
  chord: CanonicalChord,
  _platform: KeybindingPlatform
): string {
  const parts: string[] = []
  if (chord.cmd) {
    parts.push('Cmd')
  }
  if (chord.ctrl) {
    parts.push('Ctrl')
  }
  if (chord.alt) {
    parts.push('Alt')
  }
  if (chord.shift) {
    parts.push('Shift')
  }
  parts.push(formatKeyLabel(chord.key))
  return parts.join('+')
}

export function getPrimaryChordLabel(
  keymap: EffectiveKeymap,
  actionId: KeybindingActionId
): string {
  const binding = keymap.bindings.find((candidate) => candidate.id === actionId)
  if (!binding || binding.chords.length === 0) {
    return 'Unbound'
  }
  return formatCanonicalChordLabel(binding.chords[0], keymap.platform)
}

function formatKeyLabel(key: string): string {
  const label = KEY_LABELS[key]
  if (label) {
    return label
  }
  return key.length === 1 ? key.toUpperCase() : key
}
