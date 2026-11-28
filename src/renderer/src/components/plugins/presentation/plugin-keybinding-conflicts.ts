import { findKeybindingActionsForBinding } from '../../../../../shared/keybindings/formatting'
import { getKeybindingDefinition } from '../../../../../shared/keybindings/definitions'
import type {
  KeybindingActionId,
  KeybindingOverrides
} from '../../../../../shared/keybindings/types'

/** Orca's own shortcuts a plugin binding would replace, by title; inactive actions own no chord. */
export function shadowedKeybindingTitles(
  binding: string,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  inactiveActionIds: readonly KeybindingActionId[] = []
): string[] {
  return findKeybindingActionsForBinding(
    binding,
    platform,
    overrides,
    undefined,
    inactiveActionIds
  ).map((actionId) => getKeybindingDefinition(actionId)?.title ?? actionId)
}
