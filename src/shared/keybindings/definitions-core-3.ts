import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const KEYBINDING_DEFINITION_CORE_3: readonly KeybindingDefinition[] = [
  {
    id: 'browser.reload',
    title: 'Reload Browser Page',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'reload', 'refresh'],
    defaultBindings: platformBindings(['Mod+R'])
  },
  {
    id: 'browser.hardReload',
    title: 'Hard Reload Browser Page',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'reload', 'refresh', 'cache'],
    defaultBindings: platformBindings(['Mod+Shift+R'])
  },
  {
    id: 'browser.focusAddressBar',
    title: 'Focus Browser Address Bar',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'address', 'url', 'location'],
    defaultBindings: platformBindings(['Mod+L'])
  },
  {
    id: 'browser.grabElement',
    title: 'Grab Page Element',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'grab', 'copy', 'element'],
    defaultBindings: platformBindings(['Mod+C'])
  },
  {
    id: 'editor.find',
    title: 'Find in editor',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'find', 'search'],
    defaultBindings: platformBindings(['Mod+F'])
  },
  {
    id: 'editor.replace',
    title: 'Replace in editor',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'replace', 'find', 'search'],
    // Why: match the source editor's native replace shortcut per platform.
    defaultBindings: {
      darwin: ['Mod+Alt+F'],
      linux: ['Mod+H'],
      win32: ['Mod+H']
    }
  },
  {
    id: 'editor.save',
    title: 'Save File',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'save'],
    defaultBindings: platformBindings(['Mod+S'])
  },
  {
    id: 'editor.markdownPreview',
    title: 'Show Markdown Preview',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'markdown', 'preview'],
    defaultBindings: platformBindings(['Mod+Shift+V'])
  },
  {
    id: 'editor.toggleWordWrap',
    title: 'Toggle Word Wrap',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'word wrap', 'wrap', 'long lines', 'soft wrap'],
    // Why: Alt+Z matches VS Code; bare Alt+letter is not AltGr, so it stays cross-platform (#9974).
    defaultBindings: platformBindings(['Alt+Z'])
  },
  {
    id: 'editor.copyContext',
    title: 'Copy Context',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'copy', 'context'],
    defaultBindings: platformBindings(['Mod+Alt+C'])
  },
  // Why: F7 / Shift+F7 mirror VS Code / JetBrains diff-change nav; function keys are safe bare/Shift, so both opt into allowBareKeybindings.
  {
    id: 'editor.previousChange',
    title: 'Go to Previous Change',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'diff', 'change', 'hunk', 'previous'],
    defaultBindings: platformBindings(['Shift+F7']),
    allowBareKeybindings: true
  },
  {
    id: 'editor.nextChange',
    title: 'Go to Next Change',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'diff', 'change', 'hunk', 'next'],
    defaultBindings: platformBindings(['F7']),
    allowBareKeybindings: true
  },
  {
    id: 'editor.addReviewNote',
    title: 'Add Review Note',
    group: 'Editors',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'markdown', 'note', 'comment', 'annotation', 'review'],
    // Why: Ctrl+Alt+letter is AltGr text input on Windows/Linux, so an editor default must not reserve chars like Polish `ń`.
    defaultBindings: platformBindings(['Mod+Shift+A'])
  },
  {
    id: 'sourceControl.sendReviewNotes',
    title: 'Send Review Notes to Agent',
    group: 'Global',
    scope: 'global',
    // Why: fires from the global capture handler even while the editor is focused, so Settings must warn on collisions with editor chords (e.g. Add Review Note) too, not just global ones.
    conflictGroup: 'editor',
    searchKeywords: [
      'shortcut',
      'source control',
      'diff',
      'notes',
      'send',
      'agent',
      'review',
      'annotate'
    ],
    // Why: unbound by default so it never collides with existing chords; users opt in via Settings.
    defaultBindings: platformBindings([])
  },
  {
    id: 'fileExplorer.undo',
    title: 'Undo file operation',
    group: 'File Explorer',
    scope: 'fileExplorer',
    searchKeywords: ['shortcut', 'file explorer', 'undo'],
    defaultBindings: platformBindings(['Mod+Z'])
  },
  {
    id: 'fileExplorer.redo',
    title: 'Redo file operation',
    group: 'File Explorer',
    scope: 'fileExplorer',
    searchKeywords: ['shortcut', 'file explorer', 'redo'],
    defaultBindings: {
      darwin: ['Mod+Shift+Z'],
      linux: ['Mod+Shift+Z', 'Ctrl+Y'],
      win32: ['Mod+Shift+Z', 'Ctrl+Y']
    }
  },
  {
    id: 'fileExplorer.copyPath',
    title: 'Copy file path',
    group: 'File Explorer',
    scope: 'fileExplorer',
    searchKeywords: ['shortcut', 'file explorer', 'copy', 'path'],
    defaultBindings: {
      darwin: ['Mod+Alt+C'],
      linux: ['Alt+Shift+C'],
      win32: ['Alt+Shift+C']
    }
  },
  {
    id: 'fileExplorer.copyRelativePath',
    title: 'Copy relative file path',
    group: 'File Explorer',
    scope: 'fileExplorer',
    searchKeywords: ['shortcut', 'file explorer', 'copy', 'relative', 'path'],
    defaultBindings: platformBindings(['Mod+Alt+Shift+C'])
  },
  {
    id: 'fileExplorer.delete',
    title: 'Delete file',
    group: 'File Explorer',
    scope: 'fileExplorer',
    searchKeywords: ['shortcut', 'file explorer', 'delete', 'remove', 'trash'],
    defaultBindings: {
      darwin: ['Mod+Backspace', 'Delete'],
      linux: ['Delete'],
      win32: ['Delete']
    },
    allowBareKeybindings: true
  },
  {
    id: 'settings.search',
    title: 'Search Settings',
    group: 'Settings',
    scope: 'settings',
    searchKeywords: ['shortcut', 'settings', 'search', 'find'],
    defaultBindings: platformBindings(['Mod+F'])
  },
  {
    id: 'terminal.copySelection',
    title: 'Copy terminal selection',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'copy', 'selection'],
    defaultBindings: {
      darwin: ['Mod+C'],
      linux: ['Ctrl+Shift+C', 'Ctrl+C'],
      win32: ['Ctrl+Shift+C', 'Ctrl+C']
    }
  },
  {
    id: 'terminal.selectAll',
    title: 'Select all terminal text',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'select', 'all'],
    defaultBindings: {
      darwin: ['Mod+A'],
      linux: ['Ctrl+Shift+A'],
      win32: ['Ctrl+Shift+A']
    }
  },
  {
    id: 'terminal.paste',
    title: 'Paste into terminal',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'paste', 'clipboard'],
    defaultBindings: {
      darwin: ['Mod+V'],
      linux: ['Ctrl+V', 'Ctrl+Shift+V', 'Shift+Insert'],
      win32: ['Ctrl+V', 'Ctrl+Shift+V', 'Shift+Insert']
    }
  },
  {
    id: 'terminal.search',
    title: 'Search active pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'terminal', 'search', 'find'],
    defaultBindings: platformBindings(['Mod+F'])
  },
  {
    id: 'terminal.clear',
    title: 'Clear active pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'clear'],
    defaultBindings: platformBindings(['Mod+K'])
  },
  {
    id: 'terminal.focusNextPane',
    title: 'Focus next pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'focus', 'next'],
    defaultBindings: platformBindings(['Mod+BracketRight'])
  },
  {
    id: 'terminal.focusPreviousPane',
    title: 'Focus previous pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'focus', 'previous'],
    defaultBindings: platformBindings(['Mod+BracketLeft'])
  },
  {
    id: 'terminal.equalizePaneSizes',
    title: 'Equalize pane sizes',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'split', 'equalize', 'resize', 'balance', 'size'],
    defaultBindings: platformBindings([])
  },
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
  }
]
