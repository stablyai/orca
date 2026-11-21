import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

const WINDOWS_LINUX_TOGGLE_BINDINGS = ['Mod+Shift+F11', 'Mod+Shift+J']

export const KEYBINDING_DEFINITION_CORE_4: readonly KeybindingDefinition[] = [
  {
    id: 'terminal.expandPane',
    title: 'Expand / collapse pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'expand', 'collapse'],
    defaultBindings: platformBindings(['Mod+Shift+Enter'])
  },
  {
    id: 'terminal.setTitle',
    title: 'Set Title…',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'pane', 'set title', 'title', 'rename'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'dashboard.closeTerminal',
    title: 'Close Agent Terminal',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'agent', 'dashboard', 'terminal', 'preview', 'close', 'back'],
    defaultBindings: platformBindings([]),
    allowInTerminal: true
  },
  {
    id: 'sidebar.projects.toggleCollapse',
    title: 'Collapse / Expand All Projects',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'projects', 'collapse', 'expand', 'all'],
    defaultBindings: {
      darwin: ['Mod+Alt+P'],
      linux: ['Mod+Shift+H'],
      win32: ['Mod+Shift+H']
    }
  },
  {
    id: 'chat.find',
    title: 'Find in chat',
    group: 'Chat',
    scope: 'chat',
    searchKeywords: ['shortcut', 'chat', 'find', 'search'],
    defaultBindings: platformBindings(['Mod+F'])
  },
  {
    id: 'terminal.toggleNativeChat',
    title: 'Switch between Chat UI and terminal',
    group: 'Chat',
    scope: 'terminal',
    conflictGroups: ['global', 'tabs', 'terminal', 'chat', 'fileExplorer'],
    implicitDefaultYields: true,
    searchKeywords: ['shortcut', 'chat', 'chat ui', 'native chat', 'terminal', 'toggle', 'switch'],
    defaultBindings: {
      darwin: ['Mod+Shift+J'],
      // Why: Ctrl+Alt chords skip the physical-key fallback (AltGr guard), so a
      // letter primary would fail on non-Latin layouts and IMEs. Mod+Shift+J stays
      // as the alias wherever Search everything is remapped or terminal-first.
      linux: WINDOWS_LINUX_TOGGLE_BINDINGS,
      win32: WINDOWS_LINUX_TOGGLE_BINDINGS
    }
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
    id: 'terminal.copySessionId',
    title: 'Copy Session ID',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'pane', 'agent', 'copy', 'session id', 'fork'],
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
    id: 'tab.moveLeft',
    title: 'Move active tab left',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'left', 'reorder'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'tab.moveRight',
    title: 'Move active tab right',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'right', 'reorder'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'botItem.back',
    title: 'Back to Items',
    group: 'Bots',
    scope: 'botItem',
    // Why: global and tab chords run first wherever focus is, so a rebind there would shadow this.
    conflictGroups: ['global', 'tabs', 'botItem'],
    searchKeywords: ['shortcut', 'bot', 'item', 'items', 'back', 'list'],
    // Browser back's chords: Ctrl+[ is the terminal's previous-pane key off Mac.
    defaultBindings: {
      darwin: ['Mod+BracketLeft'],
      linux: ['Alt+ArrowLeft'],
      win32: ['Alt+ArrowLeft']
    }
  },
  {
    id: 'botItem.previous',
    title: 'Previous item',
    group: 'Bots',
    scope: 'botItem',
    // Why: global and tab chords run first wherever focus is, so a rebind there would shadow this.
    conflictGroups: ['global', 'tabs', 'botItem'],
    searchKeywords: ['shortcut', 'bot', 'item', 'items', 'previous', 'up'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowUp'])
  },
  {
    id: 'botItem.next',
    title: 'Next item',
    group: 'Bots',
    scope: 'botItem',
    conflictGroups: ['global', 'tabs', 'botItem'],
    searchKeywords: ['shortcut', 'bot', 'item', 'items', 'next', 'down'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowDown'])
  }
]
