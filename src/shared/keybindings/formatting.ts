import type {
  FindKeybindingConflictOptions,
  KeybindingActionId,
  KeybindingConflict,
  KeybindingDefinition,
  KeybindingOverrides,
  ModifierToken,
  KeybindingScope
} from './types'
import { KEYBINDING_DEFINITIONS, isDigitIndexActionId, isKeybindingActionId } from './definitions'
import { parseKeybinding } from './parser'
import { getEffectiveKeybindingsForAction, getEffectiveKeybindingsForDefinition } from './effective'
import { isDoubleTapBinding } from './normalization'
import { getKeybindingConflictIdentity, keybindingConflictIdentities } from './matching'

function formatModifierGlyph(modifier: ModifierToken, isMac: boolean): string {
  switch (modifier) {
    case 'Mod':
      return isMac ? '⌘' : 'Ctrl'
    case 'Cmd':
      return isMac ? '⌘' : 'Cmd'
    case 'Ctrl':
      return isMac ? '⌃' : 'Ctrl'
    case 'Alt':
      return isMac ? '⌥' : 'Alt'
    case 'Shift':
      return isMac ? '⇧' : 'Shift'
  }
}

export function formatKeybinding(binding: string, platform: NodeJS.Platform): string[] {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return [binding]
  }
  const isMac = platform === 'darwin'
  if (parsed.doubleTapModifier) {
    const glyph = formatModifierGlyph(parsed.doubleTapModifier, isMac)
    return [glyph, glyph]
  }
  const parts: string[] = []
  if (parsed.mod) {
    parts.push(isMac ? '⌘' : 'Ctrl')
  }
  if (parsed.meta) {
    parts.push(isMac ? '⌘' : 'Cmd')
  }
  if (parsed.control) {
    parts.push(isMac ? '⌃' : 'Ctrl')
  }
  if (parsed.alt) {
    parts.push(isMac ? '⌥' : 'Alt')
  }
  if (parsed.shift) {
    parts.push(isMac ? '⇧' : 'Shift')
  }
  parts.push(formatKeyToken(parsed.key, isMac))
  return parts
}

export function formatKeybindingList(
  bindings: readonly string[],
  platform: NodeJS.Platform
): string {
  if (bindings.length === 0) {
    return 'Unassigned'
  }
  return bindings
    .map((binding) => {
      const separator = isDoubleTapBinding(binding) ? ' ' : platform === 'darwin' ? '' : '+'
      return formatKeybinding(binding, platform).join(separator)
    })
    .join(', ')
}

export function findKeybindingActionsForBinding(
  binding: string,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  scopes: readonly KeybindingScope[] = ['global', 'tabs']
): KeybindingActionId[] {
  const identity = getKeybindingConflictIdentity(binding, platform)
  const allowedScopes = new Set(scopes)
  return KEYBINDING_DEFINITIONS.filter(
    (definition) =>
      allowedScopes.has(definition.scope) &&
      getEffectiveKeybindingsForAction(definition.id, platform, overrides).some((candidate) =>
        keybindingConflictIdentities(definition.id, candidate, platform).includes(identity)
      )
  ).map((definition) => definition.id)
}

const KEY_TOKEN_LABELS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Underscore: '_',
  Equal: '=',
  Plus: '+',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad -',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Tab: 'Tab',
  Escape: 'Esc',
  Space: 'Space'
}

const MAC_KEY_TOKEN_LABELS: Record<string, string> = { ...KEY_TOKEN_LABELS, Backspace: '⌫' }

function formatKeyToken(token: string, isMac: boolean): string {
  return (isMac ? MAC_KEY_TOKEN_LABELS : KEY_TOKEN_LABELS)[token] ?? token
}

export function findKeybindingConflicts(
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: FindKeybindingConflictOptions = {}
): KeybindingConflict[] {
  return findKeybindingConflictsForDefinitions(KEYBINDING_DEFINITIONS, platform, overrides, options)
}

export function findKeybindingConflictsForDefinitions(
  definitions: readonly KeybindingDefinition[],
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: FindKeybindingConflictOptions = {}
): KeybindingConflict[] {
  const owners = new Map<string, { binding: string; actionIds: Set<KeybindingActionId> }>()
  const ignoredActionIds = new Set(options.ignoredActionIds ?? [])
  const customizedActions = new Set(
    Object.keys(overrides ?? {}).filter(
      (actionId): actionId is KeybindingActionId =>
        isKeybindingActionId(actionId) && !ignoredActionIds.has(actionId)
    )
  )
  for (const actionId of options.relevantActionIds ?? []) {
    if (!ignoredActionIds.has(actionId)) {
      customizedActions.add(actionId)
    }
  }
  for (const definition of definitions) {
    if (ignoredActionIds.has(definition.id)) {
      continue
    }
    for (const binding of getEffectiveKeybindingsForDefinition(definition, platform, overrides)) {
      const groups = new Set([definition.conflictGroup ?? definition.scope])
      if (definition.conflictGroup) {
        // Why: native menu accelerators can consume global chords, so check custom bindings against both the menu bucket and scope.
        groups.add(definition.scope)
      }
      for (const group of groups) {
        for (const identity of keybindingConflictIdentities(definition.id, binding, platform)) {
          const conflictKey = `${group}\u0000${identity}`
          const current = owners.get(conflictKey) ?? { binding, actionIds: new Set() }
          if (
            !isDigitIndexActionId(definition.id) &&
            Array.from(current.actionIds).some((actionId) => isDigitIndexActionId(actionId))
          ) {
            current.binding = binding
          }
          current.actionIds.add(definition.id)
          owners.set(conflictKey, current)
        }
      }
    }
  }

  const seenConflictKeys = new Set<string>()
  return Array.from(owners.values())
    .filter(({ actionIds }) => actionIds.size > 1 && setIntersects(actionIds, customizedActions))
    .map(({ binding, actionIds }) => ({
      binding,
      actionIds: Array.from(actionIds)
    }))
    .filter((conflict) => {
      const key = `${conflict.binding}\u0000${conflict.actionIds.join('\u0000')}`
      if (seenConflictKeys.has(key)) {
        return false
      }
      seenConflictKeys.add(key)
      return true
    })
}

function setIntersects<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true
    }
  }
  return false
}
