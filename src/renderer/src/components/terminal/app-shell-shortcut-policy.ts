import { resolveKeybindingAction } from '../../../../shared/keybindings/effective-keymap'
import type {
  EffectiveKeymap,
  KeybindingCommand,
  KeybindingEvent
} from '../../../../shared/keybindings/keybinding-types'

export type AppShellShortcutAction =
  | { type: 'openNewTerminalTab' }
  | { type: 'openNewBrowserTab' }
  | { type: 'saveActiveEditorFile' }
  | { type: 'openNewMarkdownFile' }
  | { type: 'closeActiveTab' }
  | { type: 'reopenClosedTab' }
  | { type: 'switchTab'; direction: 1 | -1 }
  | { type: 'switchTabAcrossAllTypes'; direction: 1 | -1 }
  | { type: 'switchTerminalTab'; direction: 1 | -1 }

export function resolveAppShellShortcutAction(
  event: KeybindingEvent,
  keymap: EffectiveKeymap
): AppShellShortcutAction | null {
  const action = resolveKeybindingAction(keymap, event, 'mainWindow')
  return action ? commandToAppShellAction(action.command) : null
}

function commandToAppShellAction(command: KeybindingCommand): AppShellShortcutAction | null {
  switch (command.type) {
    case 'openNewTerminalTab':
      return { type: 'openNewTerminalTab' }
    case 'openNewBrowserTab':
      return { type: 'openNewBrowserTab' }
    case 'saveActiveEditorFile':
      return { type: 'saveActiveEditorFile' }
    case 'openNewMarkdownFile':
      return { type: 'openNewMarkdownFile' }
    case 'closeActiveTab':
      return { type: 'closeActiveTab' }
    case 'reopenClosedTab':
      return { type: 'reopenClosedTab' }
    case 'switchTab':
      return { type: 'switchTab', direction: command.direction === 'next' ? 1 : -1 }
    case 'switchTabAcrossAllTypes':
      return {
        type: 'switchTabAcrossAllTypes',
        direction: command.direction === 'next' ? 1 : -1
      }
    case 'switchTerminalTab':
      return { type: 'switchTerminalTab', direction: command.direction === 'next' ? 1 : -1 }
    default:
      return null
  }
}
