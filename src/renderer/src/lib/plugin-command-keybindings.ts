import type { ActivePluginCommand } from '@/store/plugin-panels'
import {
  getEffectiveKeybindingsForDefinition,
  keybindingMatchesInput,
  type KeybindingDefinition,
  type KeybindingInput,
  type KeybindingOverrides,
  type PluginKeybindingActionId
} from '../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import { pluginCommandKeybindingActionId as sharedPluginCommandKeybindingActionId } from '../../../shared/plugins/plugin-command-actions'

export function pluginCommandKeybindingActionId(
  command: Pick<ActivePluginCommand, 'pluginKey' | 'id'>
): PluginKeybindingActionId {
  return sharedPluginCommandKeybindingActionId(command.pluginKey, command.id)
}

export function pluginCommandKeybindingDefinition(
  command: ActivePluginCommand
): KeybindingDefinition {
  const defaults = command.keybindings.map((keybinding) => keybinding.key)
  return {
    id: pluginCommandKeybindingActionId(command),
    title: `${command.title} — ${command.pluginName}`,
    group: translate('auto.lib.pluginCommandKeybindings.group', 'Plugins'),
    scope: 'global',
    searchKeywords: [
      'plugin',
      'shortcut',
      command.title.toLowerCase(),
      command.pluginName.toLowerCase()
    ],
    defaultBindings: { darwin: defaults, linux: defaults, win32: defaults }
  }
}

export function buildPluginCommandKeybindingDefinitions(
  commands: readonly ActivePluginCommand[]
): KeybindingDefinition[] {
  return commands.map(pluginCommandKeybindingDefinition)
}

export function getEffectivePluginCommandKeybindings(
  command: ActivePluginCommand,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): string[] {
  return getEffectiveKeybindingsForDefinition(
    pluginCommandKeybindingDefinition(command),
    platform,
    overrides
  )
}

export function findPluginCommandForKeybinding(
  commands: readonly ActivePluginCommand[],
  input: KeybindingInput,
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides | undefined,
  hasActiveWorktree: boolean,
  options: { requireAllowInTerminal?: boolean } = {}
): ActivePluginCommand | null {
  for (const command of commands) {
    if (command.context === 'worktree' && !hasActiveWorktree) {
      continue
    }
    // Why (#15642): terminal focus only honors chords that explicitly opted in,
    // so plugin bindings keep out of the terminal's own shortcut authority by
    // default. The opt-in path matches the binding's own (already
    // schema-normalized) key rather than the override-resolved list, because
    // per-binding consent cannot be inferred from a command-level override.
    if (options.requireAllowInTerminal) {
      const terminalEligible = command.keybindings
        .filter((keybinding) => keybinding.allowInTerminal === true)
        .some((keybinding) => keybindingMatchesInput(keybinding.key, input, platform))
      if (terminalEligible) {
        return command
      }
      continue
    }
    const matches = getEffectivePluginCommandKeybindings(command, platform, overrides).some(
      (binding) => keybindingMatchesInput(binding, input, platform)
    )
    if (matches) {
      return command
    }
  }
  return null
}
