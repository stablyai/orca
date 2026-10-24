import {
  findKeybindingActionsForBinding,
  getKeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

/** Orca's own shortcuts a plugin binding would replace, by title. */
export function shadowedKeybindingTitles(
  binding: string,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): string[] {
  return findKeybindingActionsForBinding(binding, platform, overrides).map(
    (actionId) => getKeybindingDefinition(actionId)?.title ?? actionId
  )
}
