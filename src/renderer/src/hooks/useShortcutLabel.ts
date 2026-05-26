import {
  formatKeybinding,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { useAppStore } from '../store'
import { getShortcutPlatform } from '../lib/shortcut-platform'

export { getShortcutPlatform }

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

export function useShortcutLabel(actionId: KeybindingActionId): string {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutLabel(actionId, keybindings)
}

export function formatShortcutKeys(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string[] {
  const platform = getShortcutPlatform()
  const binding = getEffectiveKeybindingsForAction(actionId, platform, overrides)[0]
  return binding ? formatKeybinding(binding, platform) : []
}

export function useShortcutKeys(actionId: KeybindingActionId): string[] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeys(actionId, keybindings)
}

export function formatShortcutKeyCombos(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string[][] {
  const platform = getShortcutPlatform()
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).map((binding) =>
    formatKeybinding(binding, platform)
  )
}

export function useShortcutKeyCombos(actionId: KeybindingActionId): string[][] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeyCombos(actionId, keybindings)
}
