import type {
  KeybindingActionId,
  KeybindingDefinition,
  KeybindingInput,
  KeybindingMatchOptions,
  KeybindingOverrides,
  TerminalShortcutPolicy
} from './types'
import { isChordReservedForTextEntry, STRICTEST_TEXT_ENTRY_CLAIM } from './text-entry-reservation'
import { DEFINITIONS_BY_ID, getKeybindingPlatform, isDigitIndexActionId } from './definitions'
import {
  normalizeKeybindingWithOptions,
  normalizeOptionsForAction,
  canonicalizeDigitIndexBinding
} from './normalization'

export function getDefaultBindings(
  definition: KeybindingDefinition,
  platform: NodeJS.Platform
): string[] {
  return definition.defaultBindings[getKeybindingPlatform(platform)].map((binding) => {
    const normalized = normalizeKeybindingWithOptions(binding, {
      allowBareKeybindings: definition.allowBareKeybindings === true,
      allowShiftOnlyKeybindings: definition.allowShiftOnlyKeybindings === true
    })
    return normalized.ok ? normalized.value : binding
  })
}

export function getEffectiveKeybindingsForAction(
  actionId: KeybindingActionId,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): string[] {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  const override = overrides?.[actionId]
  if (Array.isArray(override)) {
    // Why: canonicalize digit-index overrides to <mods>+1 so display/conflict stay consistent even if a hand-edited file stored a different digit.
    if (isDigitIndexActionId(actionId)) {
      const canonical: string[] = []
      for (const binding of override) {
        const normalized = canonicalizeDigitIndexBinding(binding)
        if (normalized.ok && !canonical.includes(normalized.value)) {
          canonical.push(normalized.value)
        }
      }
      return canonical
    }
    return override.flatMap((binding) => {
      const normalized = normalizeKeybindingWithOptions(
        binding,
        normalizeOptionsForAction(actionId)
      )
      return normalized.ok ? [normalized.value] : []
    })
  }
  return definition ? getDefaultBindings(definition, platform) : []
}

export function getEffectiveKeybindingsForDefinition(
  definition: KeybindingDefinition,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): string[] {
  const override = overrides?.[definition.id]
  if (Array.isArray(override)) {
    return getEffectiveKeybindingsForAction(definition.id, platform, overrides)
  }
  return getDefaultBindings(definition, platform)
}

export function normalizeTerminalShortcutPolicy(
  policy: TerminalShortcutPolicy | null | undefined
): TerminalShortcutPolicy {
  return policy === 'terminal-first' ? 'terminal-first' : 'orca-first'
}

export function isKeybindingAllowedInTerminal(definition: KeybindingDefinition): boolean {
  return definition.scope === 'terminal' || definition.allowInTerminal === true
}

export function isKeybindingPotentialTerminalConflict(definition: KeybindingDefinition): boolean {
  return definition.scope !== 'terminal' && definition.allowInTerminal !== true
}

/**
 * Whether an action may fire while the caret sits in a text surface. Only global
 * actions are candidates: every other scope belongs to a surface the caret is not
 * in, and the tab scope already reaches text fields through its own listener.
 */
function keybindingIsActiveInTextEntry(
  definition: KeybindingDefinition,
  options: KeybindingMatchOptions,
  input: KeybindingInput | undefined,
  platform: NodeJS.Platform | undefined
): boolean {
  if (definition.scope !== 'global' || !input || !platform) {
    return false
  }
  return !isChordReservedForTextEntry(
    input,
    options.textEntryClaim ?? STRICTEST_TEXT_ENTRY_CLAIM,
    platform
  )
}

export function keybindingIsActiveInContext(
  definition: KeybindingDefinition,
  options: KeybindingMatchOptions = {},
  input?: KeybindingInput,
  platform?: NodeJS.Platform
): boolean {
  if (options.context === 'text-entry') {
    return keybindingIsActiveInTextEntry(definition, options, input, platform)
  }
  if (options.context !== 'terminal') {
    return true
  }
  // Why: Orca-first keeps app shortcuts inside terminals; terminal-first is the escape hatch for shells and TUIs.
  if (normalizeTerminalShortcutPolicy(options.terminalShortcutPolicy) === 'orca-first') {
    return true
  }
  return isKeybindingAllowedInTerminal(definition)
}
