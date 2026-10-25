import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../../../shared/keybindings'

export function sameBindings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((binding, index) => binding === b[index])
}

export function hasOwnBindingOverride(
  overrides: KeybindingOverrides,
  actionId: KeybindingActionId
): boolean {
  return Object.hasOwn(overrides, actionId)
}

export function removeBindingOverride(
  overrides: KeybindingOverrides,
  actionId: KeybindingActionId
): KeybindingOverrides {
  const next = { ...overrides }
  delete next[actionId]
  return next
}

// Reset common overrides by replacement; deleting only the platform layer would reveal them again.
export function hasCommonBindingOverride(
  snapshot: KeybindingFileSnapshot | null,
  actionId: KeybindingActionId
): boolean {
  return hasOwnBindingOverride(snapshot?.commonOverrides ?? {}, actionId)
}
