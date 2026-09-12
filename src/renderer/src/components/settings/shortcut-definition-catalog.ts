import {
  findKeybindingConflictsForDefinitions,
  formatKeybindingList,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import {
  findMacSystemHotkeyConflicts,
  type MacCapturedDigitChord
} from '../../../../shared/macos-symbolic-hotkeys'
import type { TuiAgent } from '../../../../shared/tui-agent'
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
  macCapturedDigitChords?: readonly MacCapturedDigitChord[]
  missionControlConflictMessage: string
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
  const systemConflicts = findMacSystemHotkeyConflicts(
    definitions,
    options.platform,
    options.keybindings,
    options.macCapturedDigitChords ?? []
  )
  for (const conflict of systemConflicts) {
    if (ignoredConflictActionIds.includes(conflict.actionId)) {
      continue
    }
    conflictByAction.set(conflict.actionId, [
      ...(conflictByAction.get(conflict.actionId) ?? []),
      options.missionControlConflictMessage
    ])
  }
  return {
    groups,
    definitions,
    definitionsByAction,
    ignoredConflictActionIds,
    conflictByAction
  }
}
