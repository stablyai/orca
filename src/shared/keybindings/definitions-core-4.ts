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
    id: 'workspace.togglePin',
    title: 'Toggle Workspace Pin',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'workspace', 'worktree', 'pin', 'unpin', 'toggle'],
    defaultBindings: platformBindings(['Mod+Alt+P']),
    allowInTerminal: true
  },
  {
    id: 'workspace.pin',
    title: 'Pin Workspace',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'workspace', 'worktree', 'pin'],
    // Why: the idempotent set actions exist for macros and stream decks, which bind their own
    // chord; shipping defaults here would claim two more global chords nobody presses by hand.
    defaultBindings: platformBindings([]),
    allowInTerminal: true
  },
  {
    id: 'workspace.unpin',
    title: 'Unpin Workspace',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'workspace', 'worktree', 'unpin', 'pin'],
    defaultBindings: platformBindings([]),
    allowInTerminal: true
  }
]
