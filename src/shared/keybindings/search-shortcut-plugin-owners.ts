import { pluginCommandKeybindingActionId } from '../plugins/contributions/plugin-command-actions'
import type { SearchShortcutPluginOwner } from './search-shortcut-opt-in'

// Kept out of search-shortcut-opt-in so keybinding importers don't load plugin manifest modules.
export function toSearchShortcutPluginOwners(
  commands: readonly {
    pluginKey: string
    id: string
    title: string
    keybindings: readonly { key: string }[]
  }[]
): SearchShortcutPluginOwner[] {
  // Commands without manifest keys still count: an explicit override can assign them Mod+K.
  return commands.map((command) => ({
    actionId: pluginCommandKeybindingActionId(command.pluginKey, command.id),
    title: command.title,
    defaultBindings: command.keybindings.map((keybinding) => keybinding.key)
  }))
}
