import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const KEYBINDING_DEFINITION_CORE_4: readonly KeybindingDefinition[] = [
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
  {
    id: 'view.sessions.toggle',
    title: 'Toggle Session Grid',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'sessions',
      'grid',
      'terminals',
      'agents',
      'toggle',
      'open',
      'close'
    ],
    // Why unbound: Mod+Shift+G already ships as Show Source Control and the terminal claims
    // it for find-previous; like workspace.openBoard, a new surface must not take a global chord.
    defaultBindings: platformBindings([]),
    allowInTerminal: true
  },
  // Why bare keys: the grid's own listener skips terminals and inputs, so PageDown is free there.
  {
    id: 'sessions.grid.nextPage',
    title: 'Session Grid: Next Page',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sessions', 'grid', 'page', 'row', 'next', 'down', 'scroll'],
    defaultBindings: platformBindings(['PageDown', 'Alt+ArrowDown']),
    allowBareKeybindings: true,
    allowInTerminal: true
  },
  {
    id: 'sessions.grid.prevPage',
    title: 'Session Grid: Previous Page',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sessions', 'grid', 'page', 'row', 'previous', 'up', 'scroll'],
    defaultBindings: platformBindings(['PageUp', 'Alt+ArrowUp']),
    allowBareKeybindings: true,
    allowInTerminal: true
  }
]
