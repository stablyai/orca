import {
  formatKeybinding,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  isDoubleTapBinding,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { useAppStore } from '../store'
import { getShortcutPlatform } from '../lib/shortcut-platform'

export { getShortcutPlatform }

export type ShortcutKeyComboDetails = {
  keys: string[]
  doubleTap: boolean
}

export function formatShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string {
  const platform = getShortcutPlatform()
  return formatKeybindingList(
    getEffectiveKeybindingsForAction(actionId, platform, overrides),
    platform
  )
}

export function formatPrimaryShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string {
  const platform = getShortcutPlatform()
  const [binding] = getEffectiveKeybindingsForAction(actionId, platform, overrides)
  return binding ? formatKeybindingList([binding], platform) : 'Unassigned'
}

export function useShortcutLabel(actionId: KeybindingActionId): string {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutLabel(actionId, keybindings)
}

// Why: returns null for unbound actions instead of the display sentinel
// 'Unassigned', so callers decide whether to render a hint without coupling
// UI logic to formatter copy (which may change or become localized).
export function formatOptionalShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string | null {
  const platform = getShortcutPlatform()
  const bindings = getEffectiveKeybindingsForAction(actionId, platform, overrides)
  if (bindings.length === 0) {
    return null
  }
  return formatKeybindingList(bindings, platform)
}

export function useOptionalShortcutLabel(actionId: KeybindingActionId): string | null {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatOptionalShortcutLabel(actionId, keybindings)
}

export function formatShortcutKeys(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string[] {
  return formatShortcutKeyComboDetails(actionId, overrides)[0]?.keys ?? []
}

export function useShortcutKeys(actionId: KeybindingActionId): string[] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeys(actionId, keybindings)
}

export function formatShortcutKeyComboDetails(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): ShortcutKeyComboDetails[] {
  const platform = getShortcutPlatform()
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).map((binding) => ({
    keys: formatKeybinding(binding, platform),
    doubleTap: isDoubleTapBinding(binding)
  }))
}

export function useShortcutKeyComboDetails(
  actionId: KeybindingActionId
): ShortcutKeyComboDetails[] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeyComboDetails(actionId, keybindings)
}

export function useShortcutKeyDetails(actionId: KeybindingActionId): ShortcutKeyComboDetails {
  return useShortcutKeyComboDetails(actionId)[0] ?? { keys: [], doubleTap: false }
}

export function formatShortcutKeyCombos(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string[][] {
  return formatShortcutKeyComboDetails(actionId, overrides).map((combo) => combo.keys)
}

export function useShortcutKeyCombos(actionId: KeybindingActionId): string[][] {
  return useShortcutKeyComboDetails(actionId).map((combo) => combo.keys)
}
