import type { KeybindingActionId, PluginKeybindingActionId } from '../../keybindings'
import { PLUGIN_SCHEMA_SINCE_V1 } from '../manifest/plugin-schema-field-docs'

/** Closed renderer-owned actions prevent declarative aliases targeting component-private shortcuts. */
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

/** The release each action arrived in; engines.orca must cover every one a plugin uses. */
export const PLUGIN_COMMAND_ACTION_SINCE: Record<PluginCommandAliasActionId, string> = {
  'worktree.history.back': PLUGIN_SCHEMA_SINCE_V1,
  'worktree.history.forward': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.left.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.sleepingWorkspaces.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'floatingWorkspace.maximize': PLUGIN_SCHEMA_SINCE_V1,
  'tab.rename': PLUGIN_SCHEMA_SINCE_V1,
  'workspace.rename': PLUGIN_SCHEMA_SINCE_V1,
  'workspace.openBoard': PLUGIN_SCHEMA_SINCE_V1,
  'view.tasks': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.right.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.explorer.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.search.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.sourceControl.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.checks.toggle': PLUGIN_SCHEMA_SINCE_V1,
  'sidebar.ports.toggle': PLUGIN_SCHEMA_SINCE_V1
}

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
