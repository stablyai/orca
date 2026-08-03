import {
  findKeybindingConflictsForDefinitions,
  formatKeybindingList,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import type { TuiAgent } from '../../../../shared/types'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { buildPluginCommandKeybindingDefinitions } from '@/lib/plugin-command-keybindings'
import { disabledAgentTabActionIds, groupDefinitions, type ShortcutGroup } from './shortcut-groups'

export type ShortcutDefinitionCatalog = {
  groups: ShortcutGroup[]
  definitions: KeybindingDefinition[]
  definitionsByAction: Map<KeybindingActionId, KeybindingDefinition>
  ignoredConflictActionIds: KeybindingActionId[]
  conflictByAction: Map<KeybindingActionId, string[]>
}

export function buildShortcutDefinitionCatalog(options: {
  disabledTuiAgents: readonly TuiAgent[]
  pluginCommands: readonly ActivePluginCommand[]
  keybindings: KeybindingOverrides
  platform: NodeJS.Platform
}): ShortcutDefinitionCatalog {
  const pluginDefinitions = buildPluginCommandKeybindingDefinitions(options.pluginCommands)
  const groups = groupDefinitions(options.disabledTuiAgents, pluginDefinitions)
  const definitions = groups.flatMap((group) => group.items)
  const definitionsByAction = new Map(definitions.map((definition) => [definition.id, definition]))
  const ignoredConflictActionIds = disabledAgentTabActionIds(options.disabledTuiAgents)
  const conflictByAction = new Map<KeybindingActionId, string[]>()
  const conflicts = findKeybindingConflictsForDefinitions(
    definitions,
    options.platform,
    options.keybindings,
    {
      ignoredActionIds: ignoredConflictActionIds,
      // Plugin defaults are external additions to Orca's conflict-free static
      // registry, so surface their collisions even before the user customizes one.
      relevantActionIds: pluginDefinitions.map((definition) => definition.id)
    }
  )
  for (const conflict of conflicts) {
    const labels = conflict.actionIds
      .map((id) => definitionsByAction.get(id)?.title ?? id)
      .join(', ')
    for (const actionId of conflict.actionIds) {
      conflictByAction.set(actionId, [
        ...(conflictByAction.get(actionId) ?? []),
        `${formatKeybindingList([conflict.binding], options.platform)} conflicts with ${labels}.`
      ])
    }
  }
  return {
    groups,
    definitions,
    definitionsByAction,
    ignoredConflictActionIds,
    conflictByAction
  }
}
