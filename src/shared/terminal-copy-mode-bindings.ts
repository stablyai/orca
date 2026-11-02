import {
  canonicalizeParsedKeybinding,
  getKeybindingConflictIdentity,
  hasModifier,
  keybindingMatchesInput,
  parseKeybinding,
  type KeybindingInput
} from './keybindings'

const LITERAL_KEYS = new Set(['$', '^', '_'])
const SHIFTED_LITERALS: Record<string, string> = { '4': '$', '6': '^', Minus: '_', Underscore: '_' }

export function normalizeCopyModeBinding(binding: string): string | null {
  const steps = binding
    .trim()
    .replace(/\s*\+\s*/g, '+')
    .split(/\s+/)
  if (steps.length > 2) {
    return null
  }
  const normalized: string[] = []
  for (const step of steps) {
    if (LITERAL_KEYS.has(step)) {
      normalized.push(step)
      continue
    }
    const parsed = parseKeybinding(step)
    if (!parsed || parsed.doubleTapModifier || (parsed.mod && (parsed.meta || parsed.control))) {
      return null
    }
    const literal =
      parsed.shift && !parsed.mod && !parsed.meta && !parsed.control && !parsed.alt
        ? SHIFTED_LITERALS[parsed.key]
        : undefined
    normalized.push(literal ?? canonicalizeParsedKeybinding(parsed))
  }
  return normalized.join(' ')
}

export function copyModeStrokeMatches(
  binding: string,
  input: KeybindingInput & { getModifierState?: (key: string) => boolean },
  platform: NodeJS.Platform
): boolean {
  if (!LITERAL_KEYS.has(binding)) {
    return keybindingMatchesInput(binding, input, platform)
  }
  const altGraph = input.getModifierState?.('AltGraph') === true
  return (
    input.key === binding &&
    !hasModifier(input, 'meta') &&
    (altGraph || (!hasModifier(input, 'control') && !hasModifier(input, 'alt')))
  )
}

export function copyModeBindingsOverlap(
  left: string,
  right: string,
  platform: NodeJS.Platform
): boolean {
  const a = left.split(' ')
  const b = right.split(' ')
  return a
    .slice(0, Math.min(a.length, b.length))
    .every(
      (step, index) =>
        getKeybindingConflictIdentity(step, platform) ===
        getKeybindingConflictIdentity(b[index], platform)
    )
}
