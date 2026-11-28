import { isFloatingWorkspaceKeybindingActionId } from '../../../../../shared/settings/floating-workspace-cohort'

type PluginCommandHandlerShape = {
  handler?: { type: 'built-in'; action: string } | { type: 'worker' }
}

/** Only aliases of an inactive floating action go dark; worker commands, even replacements, keep running. */
export function isPluginCommandInactiveFloatingWorkspaceAlias(
  command: PluginCommandHandlerShape,
  floatingWorkspaceShortcutsActive: boolean
): boolean {
  return (
    !floatingWorkspaceShortcutsActive &&
    command.handler?.type === 'built-in' &&
    isFloatingWorkspaceKeybindingActionId(command.handler.action)
  )
}

/** Disclosure follows the Settings cohort: existing profiles keep it even while the feature is off. */
export function isPluginReplacedActionDisclosed(
  action: string,
  floatingWorkspaceInSettings: boolean
): boolean {
  return floatingWorkspaceInSettings || !isFloatingWorkspaceKeybindingActionId(action)
}
