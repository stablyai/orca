import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const KEYBINDING_DEFINITION_CORE_4: readonly KeybindingDefinition[] = [
  {
    id: 'tab.moveToSplitRight',
    title: 'Move Tab to Split Right',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'split', 'pane', 'right'],
    // Why unbound: four directions would claim four chords, and the Mod+Alt+arrow
    // and Mod+Shift+arrow neighbourhoods are already spoken for across platforms.
    defaultBindings: { darwin: [], linux: [], win32: [] }
  },
  {
    id: 'tab.moveToSplitLeft',
    title: 'Move Tab to Split Left',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'split', 'pane', 'left'],
    // Why unbound: four directions would claim four chords, and the Mod+Alt+arrow
    // and Mod+Shift+arrow neighbourhoods are already spoken for across platforms.
    defaultBindings: { darwin: [], linux: [], win32: [] }
  },
  {
    id: 'tab.moveToSplitDown',
    title: 'Move Tab to Split Down',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'split', 'pane', 'down'],
    // Why unbound: four directions would claim four chords, and the Mod+Alt+arrow
    // and Mod+Shift+arrow neighbourhoods are already spoken for across platforms.
    defaultBindings: { darwin: [], linux: [], win32: [] }
  },
  {
    id: 'tab.moveToSplitUp',
    title: 'Move Tab to Split Up',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'split', 'pane', 'up'],
    // Why unbound: four directions would claim four chords, and the Mod+Alt+arrow
    // and Mod+Shift+arrow neighbourhoods are already spoken for across platforms.
    defaultBindings: { darwin: [], linux: [], win32: [] }
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
  }
]
