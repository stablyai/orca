import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../../../shared/keybindings'

// Predicates and edits on the per-action overrides map (distinct from
// shortcut-binding-list-mutations, which edits a single action's binding array).

export function sameBindings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((binding, index) => binding === b[index])
}

export function hasOwnBindingOverride(
  overrides: KeybindingOverrides,
  actionId: KeybindingActionId
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, actionId)
}

export function removeBindingOverride(
  overrides: KeybindingOverrides,
  actionId: KeybindingActionId
): KeybindingOverrides {
  const next = { ...overrides }
  delete next[actionId]
  return next
}

// Why: a common (cross-platform) override must be replaced, not deleted, when
// the user resets — deleting only the platform layer would fall back to it.
export function hasCommonBindingOverride(
  snapshot: KeybindingFileSnapshot | null,
  actionId: KeybindingActionId
): boolean {
  return hasOwnBindingOverride(snapshot?.commonOverrides ?? {}, actionId)
}
