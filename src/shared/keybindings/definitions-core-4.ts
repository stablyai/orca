import type { KeybindingActionId, KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

function tabGroupFocusDefinition(
  id: KeybindingActionId,
  direction: 'left' | 'down' | 'up' | 'right',
  vimKey: 'H' | 'J' | 'K' | 'L'
): KeybindingDefinition {
  return {
    id,
    title: `Focus tab group ${direction}`,
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: [
      'shortcut',
      'tab',
      'group',
      'split',
      'pane',
      'focus',
      'move',
      direction,
      vimKey.toLowerCase(),
      'vim'
    ],
    // Why: macOS only — Windows/Linux Ctrl+Alt is AltGr (Ctrl+Alt+K/L type ł/Ł on several layouts) and Linux Ctrl+Alt+L locks the screen.
    defaultBindings: { darwin: [`Ctrl+Alt+${vimKey}`], linux: [], win32: [] },
    // Why: group navigation must leave a focused terminal even under terminal-first, like pane focus.
    allowInTerminal: true
  }
}

export const KEYBINDING_DEFINITION_CORE_4: readonly KeybindingDefinition[] = [
  {
    id: 'chat.find',
    title: 'Find in chat',
    group: 'Chat',
    scope: 'chat',
    searchKeywords: ['shortcut', 'chat', 'find', 'search'],
    defaultBindings: platformBindings(['Mod+F'])
  },
  {
    id: 'sidebar.childWorkspaces.toggle',
    title: 'Toggle Child Workspaces',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'sidebar',
      'child',
      'children',
      'nested',
      'lineage',
      'workspaces',
      'worktree',
      'collapse',
      'expand',
      'show',
      'hide'
    ],
    // Why: ship unbound like the sleeping toggle, so no existing chord is claimed on any platform.
    defaultBindings: platformBindings([])
  },
  {
    id: 'terminal.clearPaneTitle',
    title: 'Clear Pane Title',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'pane', 'clear title', 'remove title', 'title'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'terminal.closePane',
    title: 'Close active pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'close'],
    defaultBindings: platformBindings(['Mod+W'])
  },
  {
    id: 'terminal.splitRight',
    title: 'Split terminal right',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'split', 'right'],
    defaultBindings: {
      darwin: ['Mod+D'],
      linux: ['Mod+Shift+D'],
      win32: ['Mod+Shift+D']
    }
  },
  {
    id: 'terminal.splitDown',
    title: 'Split terminal down',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'split', 'down'],
    defaultBindings: {
      darwin: ['Mod+Shift+D'],
      linux: ['Alt+Shift+D'],
      win32: ['Alt+Shift+D']
    }
  },
  {
    id: 'terminal.switchInputSource',
    title: 'Switch input source / language (native)',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: [
      'shortcut',
      'input',
      'source',
      'language',
      'korean',
      'english',
      'ime',
      'switch',
      'hangul',
      'layout'
    ],
    defaultBindings: {
      darwin: [],
      linux: [],
      win32: []
    },
    // Why: macOS uses Shift+Space as an input-source shortcut; Orca otherwise rejects Shift-only bindings to avoid stealing typed text.
    allowShiftOnlyKeybindings: true
  },
  tabGroupFocusDefinition('tab.focusGroupLeft', 'left', 'H'),
  tabGroupFocusDefinition('tab.focusGroupDown', 'down', 'J'),
  tabGroupFocusDefinition('tab.focusGroupUp', 'up', 'K'),
  tabGroupFocusDefinition('tab.focusGroupRight', 'right', 'L')
]
