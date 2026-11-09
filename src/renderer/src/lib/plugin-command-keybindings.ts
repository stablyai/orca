import type { ActivePluginCommand } from '@/store/plugin-panels'
import {
  getEffectiveKeybindingsForDefinition,
  keybindingMatchesAction,
  keybindingMatchesInput,
  type KeybindingDefinition,
  type KeybindingMatchOptions,
  type KeybindingInput,
  type KeybindingOverrides,
  type PluginKeybindingActionId
} from '../../../shared/keybindings'
import { fileSearchClaimsTextKey } from './file-search-shortcut-policy'
import { NATIVE_CHAT_ROOT_SELECTOR } from './native-chat-paste-request'
import {
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspaceTerminalInputTarget,
  matchFloatingWorkspacePanelChord
} from './floating-workspace-terminal-actions'
import { translate } from '@/i18n/i18n'
import { pluginCommandKeybindingActionId as sharedPluginCommandKeybindingActionId } from '../../../shared/plugins/contributions/plugin-command-actions'
import { isWorkspaceScopedPluginContext } from '../../../shared/plugins/contributions/plugin-command-contribution'

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
  hasActiveWorktree: boolean
): ActivePluginCommand | null {
  for (const command of commands) {
    if (isWorkspaceScopedPluginContext(command.context) && !hasActiveWorktree) {
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

export function globalShortcutTargetYields(
  input: KeybindingInput & Parameters<typeof fileSearchClaimsTextKey>[0],
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides | undefined,
  options: KeybindingMatchOptions
): boolean {
  // The default rename chord has no text-editing meaning, and a chat's composer is that tab's own input.
  const chatTabRename =
    input.target instanceof Element &&
    input.target.closest(NATIVE_CHAT_ROOT_SELECTOR) !== null &&
    keybindingMatchesAction('tab.rename', input, platform, overrides, options) &&
    keybindingMatchesAction('tab.rename', input, platform, undefined, options)
  return (
    (fileSearchClaimsTextKey(input) && !chatTabRename) ||
    isFloatingWorkspaceTerminalInputTarget(input.target) ||
    (isFloatingWorkspacePanelFocused() &&
      matchFloatingWorkspacePanelChord(input, platform, null, overrides, options) !== null)
  )
}
