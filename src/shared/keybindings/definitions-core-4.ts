import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

const WINDOWS_LINUX_TOGGLE_BINDINGS = ['Mod+Shift+F11', 'Mod+Shift+J']

export const KEYBINDING_DEFINITION_CORE_4: readonly KeybindingDefinition[] = [
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
      // as the alias wherever Switch worktree is remapped or terminal-first.
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
    id: 'terminal.focusPaneLeft',
    title: 'Focus pane left',
    group: 'Terminal Panes',
    scope: 'terminal',
    implicitDefaultYields: true,
    searchKeywords: ['shortcut', 'pane', 'focus', 'left', 'spatial', 'adjacent'],
    // Why: Ghostty/iTerm2 pane nav. Left/right share worktree.history chords;
    // main yields those in a focused terminal so this action can run. The
    // defaults yield to saved overrides that already claim these chords.
    defaultBindings: platformBindings(['Mod+Alt+ArrowLeft'])
  },
  {
    id: 'terminal.focusPaneRight',
    title: 'Focus pane right',
    group: 'Terminal Panes',
    scope: 'terminal',
    implicitDefaultYields: true,
    searchKeywords: ['shortcut', 'pane', 'focus', 'right', 'spatial', 'adjacent'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowRight'])
  },
  {
    id: 'terminal.focusPaneUp',
    title: 'Focus pane up',
    group: 'Terminal Panes',
    scope: 'terminal',
    implicitDefaultYields: true,
    searchKeywords: ['shortcut', 'pane', 'focus', 'up', 'spatial', 'adjacent'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowUp'])
  },
  {
    id: 'terminal.focusPaneDown',
    title: 'Focus pane down',
    group: 'Terminal Panes',
    scope: 'terminal',
    implicitDefaultYields: true,
    searchKeywords: ['shortcut', 'pane', 'focus', 'down', 'spatial', 'adjacent'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowDown'])
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
