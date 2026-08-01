import {
  formatKeybinding,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  isDoubleTapBinding,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { isCtrlCmdSwapActive } from '../../../shared/modifier-remap'
import { useAppStore } from '../store'
import { getShortcutPlatform } from '../lib/shortcut-platform'
import { isCtrlCmdSwapEnabled } from '../lib/install-modifier-remap'

export { getShortcutPlatform }

export type ShortcutKeyComboDetails = {
  keys: string[]
  doubleTap: boolean
}

// Why: hooks read the setting from the store so labels re-render the moment the remap flips;
// the plain formatters fall back to the listener's state for non-React callers.
function useSwapCtrlCmd(): boolean {
  const modifierRemap = useAppStore((state) => state.settings?.modifierRemap)
  return isCtrlCmdSwapActive(modifierRemap, getShortcutPlatform())
}

export function formatShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides,
  swapCtrlCmd: boolean = isCtrlCmdSwapEnabled()
): string {
  const platform = getShortcutPlatform()
  return formatKeybindingList(
    getEffectiveKeybindingsForAction(actionId, platform, overrides),
    platform,
    { swapCtrlCmd }
  )
}

export function formatPrimaryShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides,
  swapCtrlCmd: boolean = isCtrlCmdSwapEnabled()
): string {
  const platform = getShortcutPlatform()
  const [binding] = getEffectiveKeybindingsForAction(actionId, platform, overrides)
  return binding ? formatKeybindingList([binding], platform, { swapCtrlCmd }) : 'Unassigned'
}

export function useShortcutLabel(actionId: KeybindingActionId): string {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutLabel(actionId, keybindings, useSwapCtrlCmd())
}

// Why: returns null for unbound actions instead of the display sentinel
// 'Unassigned', so callers decide whether to render a hint without coupling
// UI logic to formatter copy (which may change or become localized).
export function formatOptionalShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides,
  swapCtrlCmd: boolean = isCtrlCmdSwapEnabled()
): string | null {
  const platform = getShortcutPlatform()
  const bindings = getEffectiveKeybindingsForAction(actionId, platform, overrides)
  if (bindings.length === 0) {
    return null
  }
  return formatKeybindingList(bindings, platform, { swapCtrlCmd })
}

export function useOptionalShortcutLabel(actionId: KeybindingActionId): string | null {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatOptionalShortcutLabel(actionId, keybindings, useSwapCtrlCmd())
}

export function formatShortcutKeys(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides,
  swapCtrlCmd: boolean = isCtrlCmdSwapEnabled()
): string[] {
  return formatShortcutKeyComboDetails(actionId, overrides, swapCtrlCmd)[0]?.keys ?? []
}

export function useShortcutKeys(actionId: KeybindingActionId): string[] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeys(actionId, keybindings, useSwapCtrlCmd())
}

export function formatShortcutKeyComboDetails(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides,
  swapCtrlCmd: boolean = isCtrlCmdSwapEnabled()
): ShortcutKeyComboDetails[] {
  const platform = getShortcutPlatform()
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).map((binding) => ({
    keys: formatKeybinding(binding, platform, { swapCtrlCmd }),
    doubleTap: isDoubleTapBinding(binding)
  }))
}

export function useShortcutKeyComboDetails(
  actionId: KeybindingActionId
): ShortcutKeyComboDetails[] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeyComboDetails(actionId, keybindings, useSwapCtrlCmd())
}

export function useShortcutKeyDetails(actionId: KeybindingActionId): ShortcutKeyComboDetails {
  return useShortcutKeyComboDetails(actionId)[0] ?? { keys: [], doubleTap: false }
}

export function formatShortcutKeyCombos(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides,
  swapCtrlCmd: boolean = isCtrlCmdSwapEnabled()
): string[][] {
  return formatShortcutKeyComboDetails(actionId, overrides, swapCtrlCmd).map((combo) => combo.keys)
}

export function useShortcutKeyCombos(actionId: KeybindingActionId): string[][] {
  return useShortcutKeyComboDetails(actionId).map((combo) => combo.keys)
}
