import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const KEYBINDING_DEFINITION_CORE_2: readonly KeybindingDefinition[] = [
  {
    id: 'floatingWorkspace.minimize',
    title: 'Minimize Floating Workspace Panel',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'floating',
      'workspace',
      'panel',
      'floating workspace',
      'workspace panel',
      'minimize',
      'hide'
    ],
    // Why: unbound everywhere since floatingTerminal.toggle owns show/hide; this exists only for an explicit user-bound "hide panel" shortcut.
    defaultBindings: {
      darwin: [],
      linux: [],
      win32: []
    },
    allowInTerminal: true
  },
  {
    id: 'zoom.in',
    title: 'Zoom In',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'zoom', 'in', 'scale'],
    defaultBindings: platformBindings(['Mod+Equal', 'Mod+Shift+Plus', 'Mod+NumpadAdd'])
  },
  {
    id: 'zoom.out',
    title: 'Zoom Out',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'zoom', 'out', 'scale'],
    defaultBindings: platformBindings(['Mod+Minus', 'Mod+NumpadSubtract'])
  },
  {
    id: 'zoom.reset',
    title: 'Reset Size',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'zoom', 'reset', 'size', 'actual'],
    defaultBindings: platformBindings(['Mod+0'])
  },
  {
    id: 'worktree.history.back',
    title: 'Worktree History Back',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'worktree', 'history', 'back'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowLeft']),
    allowInTerminal: true
  },
  {
    id: 'worktree.history.forward',
    title: 'Worktree History Forward',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'worktree', 'history', 'forward'],
    defaultBindings: platformBindings(['Mod+Alt+ArrowRight']),
    allowInTerminal: true
  },
  {
    id: 'tab.newTerminal',
    title: 'New terminal tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'terminal', 'new'],
    defaultBindings: platformBindings(['Mod+T'])
  },
  {
    id: 'tab.newAgent',
    title: 'New agent tab (default agent)',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'agent', 'new', 'default', 'launch'],
    // Why: macOS only — Windows Ctrl+Alt is AltGr and Linux Ctrl+Alt+T is the desktop "open terminal", so no safe default there.
    defaultBindings: {
      darwin: ['Mod+Alt+T'],
      linux: [],
      win32: []
    }
  },
  {
    id: 'tab.newBrowser',
    title: 'New browser tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'browser', 'new'],
    defaultBindings: platformBindings(['Mod+Shift+B'])
  },
  {
    id: 'tab.newSimulator',
    title: 'New mobile emulator tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'simulator', 'emulator', 'mobile', 'ios', 'new'],
    // Why: keep explorer on Mod+Shift+E (VS Code muscle memory); emulator is macOS-only and less common, so it yields to a free chord (#8533).
    defaultBindings: {
      darwin: ['Mod+Alt+Shift+E'],
      linux: [],
      win32: []
    }
  },
  {
    id: 'tab.newMarkdown',
    title: 'New markdown tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'markdown', 'file', 'new'],
    defaultBindings: platformBindings(['Mod+Shift+M'])
  },
  {
    id: 'tab.openMarkdown',
    title: 'Open markdown tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'markdown', 'file', 'open'],
    defaultBindings: platformBindings(['Mod+Shift+O'])
  },
  {
    id: 'tab.close',
    title: 'Close active tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'close', 'tab', 'pane'],
    defaultBindings: platformBindings(['Mod+W'])
  },
  {
    id: 'tab.closeAll',
    title: 'Close all editor tabs',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'close', 'all', 'tabs', 'files', 'editors'],
    defaultBindings: platformBindings(['Mod+Alt+W'])
  },
  {
    id: 'tab.rename',
    title: 'Rename active tab',
    group: 'Tabs',
    scope: 'tabs',
    conflictGroup: 'workspace-shell',
    searchKeywords: ['shortcut', 'tab', 'rename', 'title', 'label'],
    // Why: macOS only — Cmd+R is free in app/terminal focus; on Windows/Linux Ctrl+R is shell reverse-search, so left unbound.
    defaultBindings: {
      darwin: ['Mod+R'],
      linux: [],
      win32: []
    }
  },
  {
    id: 'tab.reopenClosed',
    title: 'Reopen closed tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'reopen', 'restore', 'closed'],
    defaultBindings: platformBindings(['Mod+Shift+T'])
  },
  {
    id: 'tab.nextSameType',
    title: 'Next tab (same type)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'next', 'switch', 'cycle'],
    // Why: the widespread "switch tab" chord (Mod+Shift+Bracket) now drives all-types cycling; same-type moved to Mod+Alt for new installs.
    defaultBindings: platformBindings(['Mod+Alt+BracketRight'])
  },
  {
    id: 'tab.previousSameType',
    title: 'Previous tab (same type)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'previous', 'switch', 'cycle'],
    defaultBindings: platformBindings(['Mod+Alt+BracketLeft'])
  },
  {
    id: 'tab.nextAllTypes',
    title: 'Next tab (all types)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'next', 'switch', 'cycle', 'all', 'any'],
    defaultBindings: platformBindings(['Mod+Shift+BracketRight'])
  },
  {
    id: 'tab.previousAllTypes',
    title: 'Previous tab (all types)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'previous', 'switch', 'cycle', 'all', 'any'],
    defaultBindings: platformBindings(['Mod+Shift+BracketLeft'])
  },
  {
    id: 'tab.previousRecent',
    title: 'Previous recent tab',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'recent', 'mru', 'switch', 'last used'],
    defaultBindings: platformBindings(['Ctrl+Tab']),
    allowInTerminal: true
  },
  {
    id: 'tab.nextTerminal',
    title: 'Next terminal tab',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'terminal', 'next', 'switch'],
    defaultBindings: platformBindings(['Ctrl+PageDown']),
    allowInTerminal: true
  },
  {
    id: 'tab.previousTerminal',
    title: 'Previous terminal tab',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'terminal', 'previous', 'switch'],
    defaultBindings: platformBindings(['Ctrl+PageUp']),
    allowInTerminal: true
  },
  {
    id: 'tab.selectByIndex',
    title: 'Select Tab 1–9',
    group: 'Tab Navigation',
    scope: 'tabs',
    // Why: no shared conflictGroup with workspace.selectByIndex so swapping their modifiers isn't a false conflict; safe because resolveWindowShortcutAction checks the workspace range first.
    searchKeywords: ['shortcut', 'tab', 'select', 'switch', 'number', 'digit', '1-9', 'index'],
    // Why: representative chord for the 1-9 range (see workspace.selectByIndex); each platform avoids the workspace-jump chord (Mod+1-9).
    defaultBindings: {
      darwin: ['Ctrl+1'],
      linux: ['Alt+1'],
      win32: ['Alt+1']
    }
  },
  {
    id: 'tab.openQuickCommandsMenu',
    title: 'Toggle Quick Commands menu',
    group: 'Quick Commands',
    scope: 'tabs',
    // Why: this tab-scoped action is also routed through the main-window allowlist, so Settings must warn when it shadows global chords.
    conflictGroup: 'global',
    searchKeywords: ['shortcut', 'quick', 'command', 'menu', 'tab', 'group', 'toggle'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'browser.find',
    title: 'Find in Browser',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'find', 'search'],
    defaultBindings: platformBindings(['Mod+F'])
  },
  {
    id: 'browser.back',
    title: 'Go Back in Browser',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'history', 'back', 'previous'],
    defaultBindings: {
      darwin: ['Mod+BracketLeft'],
      linux: ['Alt+ArrowLeft'],
      win32: ['Alt+ArrowLeft']
    }
  },
  {
    id: 'browser.forward',
    title: 'Go Forward in Browser',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'history', 'forward', 'next'],
    defaultBindings: {
      darwin: ['Mod+BracketRight'],
      linux: ['Alt+ArrowRight'],
      win32: ['Alt+ArrowRight']
    }
  }
]
