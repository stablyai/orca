import type { KeybindingActionId } from '../../../../shared/keybindings/types'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { selectFloatingWorkspaceShortcutsActive } from '@/store/slices/keybindings/floating-workspace-shortcuts-selector'
import { useOptionalShortcutLabel } from './useShortcutLabel'

/** A missing shortcut leaves the plain label, never empty parentheses. */
export function withShortcutHint(label: string, shortcutLabel: string | null): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label
}

/** Inactive floating shortcuts are inert, so their chord is never advertised. */
export function useFloatingWorkspaceShortcutLabel(actionId: KeybindingActionId): string | null {
  const active = useAppStateValue(selectFloatingWorkspaceShortcutsActive)
  const label = useOptionalShortcutLabel(actionId)
  return active ? label : null
}
