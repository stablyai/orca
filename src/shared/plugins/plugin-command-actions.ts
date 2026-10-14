import type { KeybindingActionId, PluginKeybindingActionId } from '../keybindings'

/** Built-in actions with a renderer-owned command handler. Keep this closed so
 * declarative aliases cannot target component-private shortcut implementations. */
export const PLUGIN_COMMAND_ALIAS_ACTION_IDS = [
  'worktree.history.back',
  'worktree.history.forward',
  'sidebar.left.toggle',
  'sidebar.sleepingWorkspaces.toggle',
  'floatingWorkspace.maximize',
  'tab.rename',
  'workspace.rename',
  'workspace.openBoard',
  'view.tasks',
  'sidebar.right.toggle',
  'sidebar.explorer.toggle',
  'sidebar.search.toggle',
  'sidebar.sourceControl.toggle',
  'sidebar.checks.toggle',
  'sidebar.ports.toggle'
] as const satisfies readonly KeybindingActionId[]

export type PluginCommandAliasActionId = (typeof PLUGIN_COMMAND_ALIAS_ACTION_IDS)[number]

const PLUGIN_COMMAND_ALIAS_ACTION_ID_SET = new Set<string>(PLUGIN_COMMAND_ALIAS_ACTION_IDS)

export function isPluginCommandAliasActionId(value: string): value is PluginCommandAliasActionId {
  return PLUGIN_COMMAND_ALIAS_ACTION_ID_SET.has(value)
}

export function pluginCommandKeybindingActionId(
  pluginKey: string,
  commandId: string
): PluginKeybindingActionId {
  return `plugin:${pluginKey}/${commandId}`
}
