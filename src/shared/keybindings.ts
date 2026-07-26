/* eslint-disable max-lines -- Why: keep the shortcut registry, parser, formatter, and conflict detector in one shared module so main/renderer/browser/Settings can't drift. */
import type { TuiAgent } from './types'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

export type KeybindingScope =
  | 'global'
  | 'tabs'
  | 'terminal'
  | 'browser'
  | 'editor'
  | 'fileExplorer'
  | 'composer'
  | 'settings'

export type KeybindingContext = 'app' | 'terminal' | 'browser'

export type KeybindingPlatform = 'darwin' | 'linux' | 'win32'

export type TerminalShortcutPolicy = 'orca-first' | 'terminal-first'

export type KeybindingMatchOptions = {
  context?: KeybindingContext
  terminalShortcutPolicy?: TerminalShortcutPolicy
}

export type AgentTabActionId = `tab.newAgent.${TuiAgent}`

export type KeybindingActionId =
  | 'worktree.quickOpen'
  | 'worktree.palette'
  | 'worktree.navigateUp'
  | 'worktree.navigateDown'
  | 'app.settings'
  | 'app.forceReload'
  | 'workspace.create'
  | 'workspace.rename'
  | 'workspace.delete'
  | 'workspace.openBoard'
  | 'workspace.selectByIndex'
  | 'voice.dictation'
  | 'view.tasks'
  | 'sidebar.left.toggle'
  | 'sidebar.right.toggle'
  | 'sidebar.explorer.toggle'
  | 'sidebar.search.toggle'
  | 'sidebar.sourceControl.toggle'
  | 'sidebar.checks.toggle'
  | 'sidebar.ports.toggle'
  | 'sidebar.sleepingWorkspaces.toggle'
  | 'sidebar.focusWorktreeList'
  | 'floatingTerminal.toggle'
  | 'floatingWorkspace.maximize'
  | 'floatingWorkspace.minimize'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset'
  | 'worktree.history.back'
  | 'worktree.history.forward'
  | 'tab.newTerminal'
  | 'tab.newAgent'
  | AgentTabActionId
  | 'tab.newBrowser'
  | 'tab.newSimulator'
  | 'tab.newMarkdown'
  | 'tab.openMarkdown'
  | 'tab.close'
  | 'tab.closeAll'
  | 'tab.rename'
  | 'tab.reopenClosed'
  | 'tab.nextSameType'
  | 'tab.previousSameType'
  | 'tab.nextAllTypes'
  | 'tab.previousAllTypes'
  | 'tab.previousRecent'
  | 'tab.nextTerminal'
  | 'tab.previousTerminal'
  | 'tab.selectByIndex'
  | 'tab.openQuickCommandsMenu'
  | 'browser.find'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.reload'
  | 'browser.hardReload'
  | 'browser.focusAddressBar'
  | 'browser.grabElement'
  | 'editor.find'
  | 'editor.replace'
  | 'editor.save'
  | 'editor.markdownPreview'
  | 'editor.copyContext'
  | 'editor.previousChange'
  | 'editor.nextChange'
  | 'editor.addReviewNote'
  | 'sourceControl.sendReviewNotes'
  | 'fileExplorer.undo'
  | 'fileExplorer.redo'
  | 'fileExplorer.copyPath'
  | 'fileExplorer.copyRelativePath'
  | 'fileExplorer.delete'
  | 'settings.search'
  | 'terminal.copySelection'
  | 'terminal.paste'
  | 'terminal.search'
  | 'terminal.clear'
  | 'terminal.focusNextPane'
  | 'terminal.focusPreviousPane'
  | 'terminal.equalizePaneSizes'
  | 'terminal.expandPane'
  | 'terminal.setTitle'
  | 'terminal.clearPaneTitle'
  | 'terminal.closePane'
  | 'terminal.splitRight'
  | 'terminal.splitDown'
  | 'terminal.switchInputSource'

export type KeybindingOverrides = Partial<Record<KeybindingActionId, string[]>>

export type KeybindingFileDiagnostic = {
  severity: 'warning' | 'error'
  message: string
  actionId?: string
  section?: string
}

export type KeybindingFileSnapshot = {
  path: string
  platform: KeybindingPlatform
  exists: boolean
  overrides: KeybindingOverrides
  commonOverrides: KeybindingOverrides
  platformOverrides: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
  diagnostics: KeybindingFileDiagnostic[]
}

type PlatformBindings = {
  darwin: readonly string[]
  linux: readonly string[]
  win32: readonly string[]
}

export type KeybindingDefinition = {
  id: KeybindingActionId
  title: string
  group: string
  scope: KeybindingScope
  searchKeywords: readonly string[]
  defaultBindings: PlatformBindings
  allowInTerminal?: boolean
  allowBareKeybindings?: boolean
  allowShiftOnlyKeybindings?: boolean
  conflictGroup?: string
}

export type ModifierToken = 'Mod' | 'Cmd' | 'Ctrl' | 'Alt' | 'Shift'
export type PhysicalModifierToken = Exclude<ModifierToken, 'Mod'>

export type KeybindingInput = {
  key?: string
  code?: string
  alt?: boolean
  meta?: boolean
  control?: boolean
  shift?: boolean
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  // Set only by the double-tap detector; always a physical token (never 'Mod').
  doubleTapModifier?: PhysicalModifierToken
}

type ParsedKeybinding = {
  mod: boolean
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  key: string
  doubleTapModifier?: ModifierToken
}

type NormalizeKeybindingOptions = {
  allowBareKeybindings?: boolean
  allowShiftOnlyKeybindings?: boolean
}

export type KeybindingValidationResult = { ok: true; value: string } | { ok: false; error: string }

export type KeybindingConflict = {
  binding: string
  actionIds: KeybindingActionId[]
}

export type FindKeybindingConflictOptions = {
  ignoredActionIds?: Iterable<KeybindingActionId>
}

export const KEYBINDING_DEFINITIONS: readonly KeybindingDefinition[] = [
  {
    id: 'worktree.quickOpen',
    title: 'Go to File',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'file', 'quick open'],
    defaultBindings: platformBindings(['Mod+P'])
  },
  {
    id: 'app.settings',
    title: 'Open Settings',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'settings', 'preferences'],
    defaultBindings: platformBindings(['Mod+Comma']),
    conflictGroup: 'menu'
  },
  {
    id: 'app.forceReload',
    title: 'Force Reload',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'reload', 'refresh', 'force'],
    defaultBindings: platformBindings(['Mod+Shift+R']),
    conflictGroup: 'menu'
  },
  {
    id: 'worktree.palette',
    title: 'Switch worktree',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'worktree', 'switch', 'jump'],
    defaultBindings: {
      darwin: ['Mod+J'],
      linux: ['Mod+Shift+J'],
      win32: ['Mod+Shift+J']
    }
  },
  {
    id: 'worktree.navigateUp',
    title: 'Previous worktree',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'worktree', 'previous', 'up'],
    defaultBindings: platformBindings(['Mod+Shift+ArrowUp'])
  },
  {
    id: 'worktree.navigateDown',
    title: 'Next worktree',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'worktree', 'next', 'down'],
    defaultBindings: platformBindings(['Mod+Shift+ArrowDown'])
  },
  {
    id: 'workspace.create',
    title: 'Create worktree',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'worktree', 'create', 'new workspace'],
    defaultBindings: platformBindings(['Mod+N', 'Mod+Shift+N'])
  },
  {
    id: 'workspace.rename',
    title: 'Rename worktree',
    group: 'Global',
    scope: 'global',
    conflictGroup: 'workspace-shell',
    searchKeywords: ['shortcut', 'global', 'worktree', 'rename', 'workspace', 'title'],
    // Why: macOS only — Windows/Linux Ctrl+Alt+R has no safe default (Ctrl+R reverse-search, Ctrl+Shift+R reload are taken).
    defaultBindings: {
      darwin: ['Mod+Alt+R'],
      linux: [],
      win32: []
    }
  },
  {
    id: 'workspace.delete',
    title: 'Delete Workspace',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'global',
      'workspace',
      'current workspace',
      'worktree',
      'delete',
      'remove',
      'trash'
    ],
    // Why: ship now without a default chord; user overrides still win when a future default is assigned.
    defaultBindings: platformBindings([]),
    allowInTerminal: true
  },
  {
    id: 'workspace.openBoard',
    title: 'Open Workspace Board',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'global', 'workspace', 'board', 'kanban', 'worktree'],
    // Why: configurable but unbound by default, to not take a global chord from terminal/browser/editor users.
    defaultBindings: platformBindings([]),
    allowInTerminal: true
  },
  {
    id: 'workspace.selectByIndex',
    title: 'Select Workspace 1–9',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'global',
      'workspace',
      'worktree',
      'select',
      'switch',
      'number',
      'digit',
      '1-9',
      'index'
    ],
    // Why: one remappable row covers the whole 1-9 range (stored chord is a representative; any of 1-9 fires it).
    defaultBindings: platformBindings(['Mod+1'])
  },
  {
    id: 'voice.dictation',
    title: 'Dictation',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'dictation', 'voice', 'speech', 'microphone'],
    defaultBindings: platformBindings(['Mod+E'])
  },
  {
    id: 'view.tasks',
    title: 'Open Tasks',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'tasks', 'github issues', 'linear'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'sidebar.left.toggle',
    title: 'Toggle Sidebar',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'left'],
    defaultBindings: platformBindings(['Mod+B'])
  },
  {
    id: 'sidebar.right.toggle',
    title: 'Toggle Right Sidebar',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'right'],
    defaultBindings: platformBindings(['Mod+L'])
  },
  {
    id: 'sidebar.explorer.toggle',
    title: 'Show Explorer',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'explorer', 'files'],
    defaultBindings: platformBindings(['Mod+Shift+E'])
  },
  {
    id: 'sidebar.search.toggle',
    title: 'Show Search',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'search'],
    defaultBindings: platformBindings(['Mod+Shift+F'])
  },
  {
    id: 'sidebar.sourceControl.toggle',
    title: 'Show Source Control',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'source control', 'git'],
    defaultBindings: platformBindings(['Mod+Shift+G'])
  },
  {
    id: 'sidebar.checks.toggle',
    title: 'Show Checks',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'checks', 'ci'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'sidebar.ports.toggle',
    title: 'Show Ports',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'ports'],
    defaultBindings: {
      darwin: ['Mod+Shift+I'],
      linux: [],
      win32: []
    }
  },
  {
    id: 'sidebar.sleepingWorkspaces.toggle',
    title: 'Toggle Sleeping Workspaces',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'sidebar',
      'sleeping',
      'asleep',
      'workspaces',
      'worktree',
      'filter',
      'show',
      'hide'
    ],
    // Why: ship unbound (issue #5209 asks users to assign it), avoiding a claimed cross-platform chord.
    defaultBindings: platformBindings([])
  },
  {
    id: 'sidebar.focusWorktreeList',
    title: 'Focus worktree list',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'worktree', 'focus'],
    // Why: keep zoom.reset on the browser-standard Mod+0; this chord was unreachable while it shared that default (#8584).
    defaultBindings: platformBindings(['Mod+Shift+0'])
  },
  {
    id: 'floatingTerminal.toggle',
    title: 'Toggle Floating Terminal',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'floating terminal', 'terminal'],
    defaultBindings: platformBindings(['Mod+Alt+A']),
    allowInTerminal: true
  },
  {
    id: 'floatingWorkspace.maximize',
    title: 'Maximize Floating Workspace Panel',
    group: 'Global',
    scope: 'global',
    searchKeywords: [
      'shortcut',
      'floating',
      'workspace',
      'panel',
      'floating workspace',
      'workspace panel',
      'maximize',
      'expand'
    ],
    // Why: pairs with floatingTerminal.toggle (Cmd+Opt+A) so maximize stays one-handed; macOS-only, Linux/Windows unbound.
    defaultBindings: {
      darwin: ['Mod+Alt+Shift+A'],
      linux: [],
      win32: []
    },
    allowInTerminal: true
  },
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
  },
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
    defaultBindings: platformBindings(['Mod+Shift+C'])
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
  ...buildAgentTabKeybindingDefinitions()
]

/** Pre-swap tab-switch bindings; a one-time migration pins these for pre-release installs so upgrading users keep the shortcuts they learned. */
export const LEGACY_TAB_SWITCH_BINDINGS: Readonly<Partial<Record<KeybindingActionId, string[]>>> = {
  'tab.nextSameType': ['Mod+Shift+BracketRight'],
  'tab.previousSameType': ['Mod+Shift+BracketLeft'],
  'tab.nextAllTypes': ['Mod+Alt+BracketRight'],
  'tab.previousAllTypes': ['Mod+Alt+BracketLeft']
}

export function agentTabActionId(agent: TuiAgent): AgentTabActionId {
  return `tab.newAgent.${agent}`
}

// Why: one bindable action per agent; all ship unassigned since tab.newAgent covers the default, and Settings hides disabled agents.
function buildAgentTabKeybindingDefinitions(): KeybindingDefinition[] {
  return ALL_TUI_AGENTS.map((agent) => ({
    id: agentTabActionId(agent),
    title: `New ${TUI_AGENT_DISPLAY_NAMES[agent]} tab`,
    group: 'Agents',
    scope: 'tabs',
    searchKeywords: [
      'shortcut',
      'tab',
      'agent',
      'new',
      'launch',
      agent,
      TUI_AGENT_DISPLAY_NAMES[agent].toLowerCase()
    ],
    defaultBindings: platformBindings([])
  }))
}

const DEFINITIONS_BY_ID = new Map<KeybindingActionId, KeybindingDefinition>(
  KEYBINDING_DEFINITIONS.map((definition) => [definition.id, definition])
)

const DEFINITION_IDS = new Set<KeybindingActionId>(
  KEYBINDING_DEFINITIONS.map((definition) => definition.id)
)

// Why: these ids are single remappable rows whose chord is a representative — the digit canonicalizes to 1 but the binding fires for any 1-9.
export const DIGIT_INDEX_ACTION_IDS: readonly KeybindingActionId[] = [
  'tab.selectByIndex',
  'workspace.selectByIndex'
]

const DIGIT_INDEX_ACTION_ID_SET = new Set<KeybindingActionId>(DIGIT_INDEX_ACTION_IDS)

// The representative key for a digit-index chord is a single 1-9 number key.
const DIGIT_INDEX_KEY_PATTERN = /^[1-9]$/

export function isDigitIndexActionId(actionId: KeybindingActionId): boolean {
  return DIGIT_INDEX_ACTION_ID_SET.has(actionId)
}

function platformBindings(bindings: readonly string[]): PlatformBindings {
  return {
    darwin: bindings,
    linux: bindings,
    win32: bindings
  }
}

export function getKeybindingPlatform(platform: NodeJS.Platform): KeybindingPlatform {
  return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'
}

export function isKeybindingActionId(value: string): value is KeybindingActionId {
  return DEFINITION_IDS.has(value as KeybindingActionId)
}

function hasModifier(
  input: KeybindingInput,
  modifier: 'alt' | 'meta' | 'control' | 'shift'
): boolean {
  if (modifier === 'alt') {
    return Boolean(input.alt ?? input.altKey)
  }
  if (modifier === 'meta') {
    return Boolean(input.meta ?? input.metaKey)
  }
  if (modifier === 'control') {
    return Boolean(input.control ?? input.ctrlKey)
  }
  return Boolean(input.shift ?? input.shiftKey)
}

function isFunctionKeyToken(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
}

function normalizeKeyToken(token: string): string | null {
  if (token === ' ') {
    return 'Space'
  }
  const trimmed = token.trim()
  if (!trimmed) {
    return null
  }
  const upper = trimmed.toUpperCase()
  if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
    return upper
  }
  if (upper.length === 1 && upper >= '0' && upper <= '9') {
    return upper
  }
  // Function keys F1–F24 (event.key/event.code report them verbatim, e.g. F7).
  if (isFunctionKeyToken(upper)) {
    return upper
  }

  const simple: Record<string, string> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '{': 'BracketLeft',
    '}': 'BracketRight',
    '-': 'Minus',
    _: 'Underscore',
    '=': 'Equal',
    '+': 'Plus',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    RETURN: 'Enter',
    ESC: 'Escape',
    SPACEBAR: 'Space',
    PGUP: 'PageUp',
    PGDN: 'PageDown',
    PLUS: 'Plus',
    MINUS: 'Minus',
    EQUAL: 'Equal',
    UNDERSCORE: 'Underscore',
    ARROWLEFT: 'ArrowLeft',
    LEFT: 'ArrowLeft',
    ARROWRIGHT: 'ArrowRight',
    RIGHT: 'ArrowRight',
    ARROWUP: 'ArrowUp',
    UP: 'ArrowUp',
    ARROWDOWN: 'ArrowDown',
    DOWN: 'ArrowDown',
    PAGEUP: 'PageUp',
    PAGEDOWN: 'PageDown',
    BACKSPACE: 'Backspace',
    DELETE: 'Delete',
    DEL: 'Delete',
    INSERT: 'Insert',
    INS: 'Insert',
    ENTER: 'Enter',
    TAB: 'Tab',
    ESCAPE: 'Escape',
    SPACE: 'Space',
    BRACKETLEFT: 'BracketLeft',
    BRACKETRIGHT: 'BracketRight',
    NUMPADADD: 'NumpadAdd',
    NUMPADSUBTRACT: 'NumpadSubtract',
    ADD: 'NumpadAdd',
    SUBTRACT: 'NumpadSubtract',
    COMMA: 'Comma',
    PERIOD: 'Period',
    SLASH: 'Slash',
    BACKSLASH: 'Backslash',
    SEMICOLON: 'Semicolon',
    QUOTE: 'Quote',
    BACKQUOTE: 'Backquote'
  }

  return simple[upper] ?? null
}

function parseModifierToken(rawPart: string): ModifierToken | null {
  const part = rawPart.toLowerCase()
  if (part === 'mod' || part === 'cmdorctrl' || part === 'commandorcontrol') {
    return 'Mod'
  }
  if (part === 'cmd' || part === 'command' || part === 'meta' || rawPart === '⌘') {
    return 'Cmd'
  }
  if (part === 'ctrl' || part === 'control' || rawPart === '⌃') {
    return 'Ctrl'
  }
  if (part === 'alt' || part === 'option' || part === 'opt' || rawPart === '⌥') {
    return 'Alt'
  }
  if (part === 'shift' || rawPart === '⇧') {
    return 'Shift'
  }
  return null
}

function applyModifierToken(parsed: ParsedKeybinding, modifier: ModifierToken): void {
  if (modifier === 'Mod') {
    parsed.mod = true
  } else if (modifier === 'Cmd') {
    parsed.meta = true
  } else if (modifier === 'Ctrl') {
    parsed.control = true
  } else if (modifier === 'Alt') {
    parsed.alt = true
  } else {
    parsed.shift = true
  }
}

function emptyParsedKeybinding(): ParsedKeybinding {
  return { mod: false, meta: false, control: false, alt: false, shift: false, key: '' }
}

// Why: a double-tap is a bare modifier with no key, so it can't use the normal parse path; modifier validation is deferred to normalize.
function parseDoubleTapKeybinding(rawParts: string[]): ParsedKeybinding | null {
  const modifiers: ModifierToken[] = []
  let sawDoubleTap = false
  for (const rawPart of rawParts) {
    if (rawPart.toLowerCase() === 'doubletap') {
      if (sawDoubleTap) {
        return null
      }
      sawDoubleTap = true
      continue
    }
    const modifier = parseModifierToken(rawPart)
    if (!modifier) {
      return null
    }
    modifiers.push(modifier)
  }
  if (modifiers.length === 0) {
    return null
  }
  const parsed = emptyParsedKeybinding()
  for (const modifier of modifiers) {
    applyModifierToken(parsed, modifier)
  }
  // Keep both flags when Mod is combined with a platform modifier, so normalize emits the shared "Mod or platform-specific, not both" error.
  if (parsed.mod && (parsed.meta || parsed.control)) {
    parsed.doubleTapModifier = 'Mod'
    return parsed
  }
  if (modifiers.length > 1) {
    return null
  }
  parsed.doubleTapModifier = modifiers[0]
  return parsed
}

function parseKeybinding(binding: string): ParsedKeybinding | null {
  const rawParts = binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (rawParts.length === 0) {
    return null
  }

  if (rawParts.some((part) => part.toLowerCase() === 'doubletap')) {
    return parseDoubleTapKeybinding(rawParts)
  }

  const parsed = emptyParsedKeybinding()
  for (const rawPart of rawParts) {
    const modifier = parseModifierToken(rawPart)
    if (modifier) {
      applyModifierToken(parsed, modifier)
      continue
    }
    if (parsed.key) {
      return null
    }
    const key = normalizeKeyToken(rawPart)
    if (!key) {
      return null
    }
    parsed.key = key
  }

  return parsed.key ? parsed : null
}

function canonicalizeParsedKeybinding(parsed: ParsedKeybinding): string {
  if (parsed.doubleTapModifier) {
    return `DoubleTap+${parsed.doubleTapModifier}`
  }
  const parts: string[] = []
  if (parsed.mod) {
    parts.push('Mod')
  }
  if (parsed.meta) {
    parts.push('Cmd')
  }
  if (parsed.control) {
    parts.push('Ctrl')
  }
  if (parsed.alt) {
    parts.push('Alt')
  }
  if (parsed.shift) {
    parts.push('Shift')
  }
  parts.push(parsed.key)
  return parts.join('+')
}

function isSafeBareKey(parsed: ParsedKeybinding): boolean {
  if (parsed.mod || parsed.meta || parsed.control || parsed.alt) {
    return false
  }
  // Function keys produce no text, so they're safe bare or with Shift (Shift+letter stays unsafe).
  if (parsed.shift) {
    return isFunctionKeyToken(parsed.key)
  }
  return (
    isFunctionKeyToken(parsed.key) ||
    [
      'Backspace',
      'Delete',
      'Enter',
      'Escape',
      'Tab',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown'
    ].includes(parsed.key)
  )
}

function normalizeKeybindingWithOptions(
  binding: string,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return { ok: false, error: 'Use a shortcut like Ctrl+Shift+P or Cmd+K.' }
  }
  if (parsed.mod && (parsed.meta || parsed.control)) {
    return { ok: false, error: 'Use either Mod or a platform-specific modifier, not both.' }
  }
  if (parsed.doubleTapModifier) {
    return { ok: true, value: canonicalizeParsedKeybinding(parsed) }
  }
  const isShiftInsert = parsed.shift && parsed.key === 'Insert'
  const isBareAllowed = options.allowBareKeybindings === true && isSafeBareKey(parsed)
  const isShiftOnlyAllowed =
    options.allowShiftOnlyKeybindings === true &&
    parsed.shift &&
    !parsed.mod &&
    !parsed.meta &&
    !parsed.control &&
    !parsed.alt
  if (
    !parsed.mod &&
    !parsed.meta &&
    !parsed.control &&
    !parsed.alt &&
    !isShiftInsert &&
    !isBareAllowed &&
    !isShiftOnlyAllowed
  ) {
    return { ok: false, error: 'Include at least one modifier key.' }
  }
  return { ok: true, value: canonicalizeParsedKeybinding(parsed) }
}

export function normalizeKeybinding(binding: string): KeybindingValidationResult {
  return normalizeKeybindingWithOptions(binding)
}

export function isDoubleTapBinding(binding: string): boolean {
  return Boolean(parseKeybinding(binding)?.doubleTapModifier)
}

function normalizeKeybindingListWithOptions(
  input: string,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult | string[] {
  const trimmed = input.trim()
  if (!trimmed) {
    return []
  }
  const normalized: string[] = []
  for (const piece of trimmed.split(',')) {
    const result = normalizeKeybindingWithOptions(piece, options)
    if (!result.ok) {
      return result
    }
    if (!normalized.includes(result.value)) {
      normalized.push(result.value)
    }
  }
  return normalized
}

export function normalizeKeybindingList(input: string): KeybindingValidationResult | string[] {
  return normalizeKeybindingListWithOptions(input)
}

function normalizeKeybindingArrayWithOptions(
  input: readonly string[],
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult | string[] {
  const normalized: string[] = []
  for (const binding of input) {
    const piece = normalizeKeybindingListWithOptions(binding, options)
    if (!Array.isArray(piece)) {
      return piece
    }
    for (const normalizedBinding of piece) {
      if (!normalized.includes(normalizedBinding)) {
        normalized.push(normalizedBinding)
      }
    }
  }
  return normalized
}

function normalizeOptionsForAction(actionId: KeybindingActionId): NormalizeKeybindingOptions {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  return {
    allowBareKeybindings: definition?.allowBareKeybindings === true,
    allowShiftOnlyKeybindings: definition?.allowShiftOnlyKeybindings === true
  }
}

// Why: rewrite a digit-index chord's key to 1 so display and conflict detection stay stable across the 1-9 range; reject any non 1-9 key.
function canonicalizeDigitIndexBinding(binding: string): KeybindingValidationResult {
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
    return {
      ok: false,
      error: 'Pick a number key 1–9 with a modifier, like Cmd+1 or Ctrl+1.'
    }
  }
  return { ok: true, value: canonicalizeParsedKeybinding({ ...parsed, key: '1' }) }
}

function finalizeDigitIndexBindings(
  actionId: KeybindingActionId,
  result: KeybindingValidationResult | string[]
): KeybindingValidationResult | string[] {
  if (!isDigitIndexActionId(actionId) || !Array.isArray(result)) {
    return result
  }
  const canonical: string[] = []
  for (const binding of result) {
    const normalized = canonicalizeDigitIndexBinding(binding)
    if (!normalized.ok) {
      return normalized
    }
    if (!canonical.includes(normalized.value)) {
      canonical.push(normalized.value)
    }
  }
  return canonical
}

export function normalizeKeybindingListForAction(
  actionId: KeybindingActionId,
  input: string
): KeybindingValidationResult | string[] {
  return finalizeDigitIndexBindings(
    actionId,
    normalizeKeybindingListWithOptions(input, normalizeOptionsForAction(actionId))
  )
}

export function normalizeKeybindingArrayForAction(
  actionId: KeybindingActionId,
  input: readonly string[]
): KeybindingValidationResult | string[] {
  return finalizeDigitIndexBindings(
    actionId,
    normalizeKeybindingArrayWithOptions(input, normalizeOptionsForAction(actionId))
  )
}

const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'Control',
  'Meta',
  'Shift',
  'OS',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock'
])

const PUNCTUATION_KEY_TOKENS = new Set([
  'BracketLeft',
  'BracketRight',
  'Minus',
  'Underscore',
  'Equal',
  'Plus',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote'
])

const PHYSICAL_CODE_FALLBACK_KEYS = new Set(['', 'Dead', 'Unidentified'])

const SHIFTED_PUNCTUATION_KEY_TOKENS: Record<string, string> = {
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '~': 'Backquote'
}

function logicalKeyTokenFromInput(input: KeybindingInput): string | null {
  const key = input.key ?? ''
  if (MODIFIER_KEYS.has(key)) {
    return null
  }
  const normalizedKey = normalizeKeyToken(key)
  if (normalizedKey) {
    return normalizedKey
  }
  if (hasModifier(input, 'shift')) {
    return SHIFTED_PUNCTUATION_KEY_TOKENS[key] ?? null
  }
  return null
}

function canUsePhysicalCodeFallback(input: KeybindingInput): boolean {
  // Why: layout-aware shortcuts trust real logical keys; physical code is only a fallback when the platform can't report the produced key.
  return PHYSICAL_CODE_FALLBACK_KEYS.has(input.key ?? '')
}

function isLatinShortcutKey(key: string): boolean {
  // Why: A-Z / 0-9 are the only chars a Latin shortcut names; a non-Latin char (Cyrillic с, Greek π) is never a Latin remap, so physical-code fallback is safe.
  if (key.length !== 1) {
    return false
  }
  const upper = key.toUpperCase()
  return (upper >= 'A' && upper <= 'Z') || (key >= '0' && key <= '9')
}

function shouldUseNonLatinShortcutPhysicalFallback(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: non-Latin layouts report non-Latin logical keys for physical letters (#6274), breaking Ctrl/Meta shortcuts; fall back to the physical code.
  if (getKeybindingPlatform(platform) === 'darwin') {
    return false
  }
  const hasPrimaryModifier = hasModifier(input, 'control') || hasModifier(input, 'meta')
  if (!hasPrimaryModifier) {
    return false
  }
  // AltGr surfaces as Ctrl+Alt on Windows/Linux; treat it as text, not a chord.
  if (hasModifier(input, 'control') && hasModifier(input, 'alt')) {
    return false
  }
  if (logicalKeyTokenFromInput(input) !== null) {
    return false
  }
  const key = input.key ?? ''
  return key !== '' && !MODIFIER_KEYS.has(key) && !isLatinShortcutKey(key)
}

function canFallBackToPhysicalCode(input: KeybindingInput, platform: NodeJS.Platform): boolean {
  return (
    canUsePhysicalCodeFallback(input) || shouldUseNonLatinShortcutPhysicalFallback(input, platform)
  )
}

function physicalCodeKeyTokenFromInput(input: KeybindingInput): string | null {
  const code = input.code ?? ''
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toUpperCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5)
  }

  return normalizeKeyToken(code)
}

function numpadCodeKeyTokenFromInput(input: KeybindingInput): string | null {
  const code = input.code ?? ''
  return code === 'NumpadAdd' || code === 'NumpadSubtract' ? normalizeKeyToken(code) : null
}

function shouldUseMacOptionComposedCaptureFallback(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: macOS Option+key reports composed characters (Option+C -> ç), so capturing Alt shortcuts needs the physical-code fallback.
  if (
    getKeybindingPlatform(platform) !== 'darwin' ||
    !hasModifier(input, 'alt') ||
    MODIFIER_KEYS.has(input.key ?? '')
  ) {
    return false
  }
  const physicalToken = physicalCodeKeyTokenFromInput(input)
  if (!physicalToken) {
    return false
  }
  return (
    (physicalToken.length === 1 && physicalToken >= 'A' && physicalToken <= 'Z') ||
    isPunctuationKeyToken(physicalToken)
  )
}

function keyTokenFromInput(input: KeybindingInput, platform: NodeJS.Platform): string | null {
  const numpadKey = numpadCodeKeyTokenFromInput(input)
  if (numpadKey) {
    return numpadKey
  }
  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey) {
    return logicalKey
  }
  if (
    !canUsePhysicalCodeFallback(input) &&
    !shouldUseMacOptionComposedCaptureFallback(input, platform) &&
    !shouldUseNonLatinShortcutPhysicalFallback(input, platform)
  ) {
    return null
  }
  return physicalCodeKeyTokenFromInput(input)
}

// Why: the platform primary modifier canonicalizes to Mod (Cmd on macOS / Ctrl elsewhere), mirroring normal capture.
function canonicalDoubleTapToken(
  modifier: PhysicalModifierToken,
  platform: NodeJS.Platform
): ModifierToken {
  const isMac = platform === 'darwin'
  if (modifier === 'Cmd' && isMac) {
    return 'Mod'
  }
  if (modifier === 'Ctrl' && !isMac) {
    return 'Mod'
  }
  return modifier
}

function keybindingFromInputWithOptions(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult {
  if (input.doubleTapModifier) {
    return normalizeKeybindingWithOptions(
      `DoubleTap+${canonicalDoubleTapToken(input.doubleTapModifier, platform)}`,
      options
    )
  }
  const key = keyTokenFromInput(input, platform)
  if (!key) {
    return { ok: false, error: 'Press a key, not only a modifier.' }
  }

  const isMac = getKeybindingPlatform(platform) === 'darwin'
  const parts: string[] = []
  const primaryModifierPressed = isMac ? hasModifier(input, 'meta') : hasModifier(input, 'control')
  if (primaryModifierPressed) {
    parts.push('Mod')
  }
  if (isMac && hasModifier(input, 'control')) {
    parts.push('Ctrl')
  }
  if (!isMac && hasModifier(input, 'meta')) {
    parts.push('Cmd')
  }
  if (hasModifier(input, 'alt')) {
    parts.push('Alt')
  }
  if (hasModifier(input, 'shift')) {
    parts.push('Shift')
  }
  parts.push(key)

  return normalizeKeybindingWithOptions(parts.join('+'), options)
}

export function keybindingFromInput(
  input: KeybindingInput,
  platform: NodeJS.Platform
): KeybindingValidationResult {
  return keybindingFromInputWithOptions(input, platform)
}

export function keybindingFromInputForAction(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform
): KeybindingValidationResult {
  const result = keybindingFromInputWithOptions(
    input,
    platform,
    normalizeOptionsForAction(actionId)
  )
  if (!result.ok || !isDigitIndexActionId(actionId)) {
    return result
  }
  return canonicalizeDigitIndexBinding(result.value)
}

function getDefaultBindings(definition: KeybindingDefinition, platform: NodeJS.Platform): string[] {
  return definition.defaultBindings[getKeybindingPlatform(platform)].map((binding) => {
    const normalized = normalizeKeybindingWithOptions(binding, {
      allowBareKeybindings: definition.allowBareKeybindings === true,
      allowShiftOnlyKeybindings: definition.allowShiftOnlyKeybindings === true
    })
    return normalized.ok ? normalized.value : binding
  })
}

export function getEffectiveKeybindingsForAction(
  actionId: KeybindingActionId,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): string[] {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  if (!definition) {
    return []
  }
  const override = overrides?.[actionId]
  if (Array.isArray(override)) {
    // Why: canonicalize digit-index overrides to <mods>+1 so display/conflict stay consistent even if a hand-edited file stored a different digit.
    if (isDigitIndexActionId(actionId)) {
      const canonical: string[] = []
      for (const binding of override) {
        const normalized = canonicalizeDigitIndexBinding(binding)
        if (normalized.ok && !canonical.includes(normalized.value)) {
          canonical.push(normalized.value)
        }
      }
      return canonical
    }
    return override.flatMap((binding) => {
      const normalized = normalizeKeybindingWithOptions(
        binding,
        normalizeOptionsForAction(actionId)
      )
      return normalized.ok ? [normalized.value] : []
    })
  }
  return getDefaultBindings(definition, platform)
}

export function getKeybindingDefinition(actionId: KeybindingActionId): KeybindingDefinition | null {
  return DEFINITIONS_BY_ID.get(actionId) ?? null
}

export function normalizeTerminalShortcutPolicy(
  policy: TerminalShortcutPolicy | null | undefined
): TerminalShortcutPolicy {
  return policy === 'terminal-first' ? 'terminal-first' : 'orca-first'
}

export function isKeybindingAllowedInTerminal(definition: KeybindingDefinition): boolean {
  return definition.scope === 'terminal' || definition.allowInTerminal === true
}

export function isKeybindingPotentialTerminalConflict(definition: KeybindingDefinition): boolean {
  return definition.scope !== 'terminal' && definition.allowInTerminal !== true
}

export function keybindingIsActiveInContext(
  definition: KeybindingDefinition,
  options: KeybindingMatchOptions = {}
): boolean {
  if (options.context !== 'terminal') {
    return true
  }
  // Why: Orca-first keeps app shortcuts inside terminals; terminal-first is the escape hatch for shells and TUIs.
  if (normalizeTerminalShortcutPolicy(options.terminalShortcutPolicy) === 'orca-first') {
    return true
  }
  return isKeybindingAllowedInTerminal(definition)
}

function platformModifiers(
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): { meta: boolean; control: boolean; alt: boolean; shift: boolean } {
  const isMac = platform === 'darwin'
  return {
    meta: parsed.meta || (parsed.mod && isMac),
    control: parsed.control || (parsed.mod && !isMac),
    alt: parsed.alt,
    shift: parsed.shift
  }
}

function modifierStateMatches(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  const expected = platformModifiers(parsed, platform)
  return (
    hasModifier(input, 'meta') === expected.meta &&
    hasModifier(input, 'control') === expected.control &&
    hasModifier(input, 'alt') === expected.alt &&
    hasModifier(input, 'shift') === expected.shift
  )
}

function shouldUseMacOptionLetterPhysicalFallback(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: macOS Option+letter reports composed characters (Option+A -> å), leaving no logical Latin key for Alt shortcuts.
  return (
    getKeybindingPlatform(platform) === 'darwin' &&
    parsed.alt &&
    hasModifier(input, 'alt') &&
    logicalKeyTokenFromInput(input) === null
  )
}

function shouldUseMacOptionPunctuationPhysicalFallback(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: macOS Option+punctuation reports composed dead-key values, leaving no logical bracket token for Alt shortcuts.
  return (
    getKeybindingPlatform(platform) === 'darwin' &&
    parsed.alt &&
    hasModifier(input, 'alt') &&
    logicalKeyTokenFromInput(input) === null
  )
}

function letterKeyMatches(
  input: KeybindingInput,
  letter: string,
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): boolean {
  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey && logicalKey.length === 1 && logicalKey >= 'A' && logicalKey <= 'Z') {
    return logicalKey === letter.toUpperCase()
  }
  return (
    (canFallBackToPhysicalCode(input, platform) ||
      shouldUseMacOptionLetterPhysicalFallback(parsed, input, platform)) &&
    input.code === `Key${letter.toUpperCase()}`
  )
}

function digitKeyMatches(
  input: KeybindingInput,
  digit: string,
  platform: NodeJS.Platform
): boolean {
  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey && logicalKey.length === 1 && logicalKey >= '0' && logicalKey <= '9') {
    return logicalKey === digit
  }
  return canFallBackToPhysicalCode(input, platform) && input.code === `Digit${digit}`
}

function isPunctuationKeyToken(token: string | null): token is string {
  return token !== null && PUNCTUATION_KEY_TOKENS.has(token)
}

function semanticPunctuationKey(input: KeybindingInput): string | null {
  const logicalKey = logicalKeyTokenFromInput(input)
  return isPunctuationKeyToken(logicalKey) ? logicalKey : null
}

function physicalPunctuationKey(input: KeybindingInput): string | null {
  const physicalKey = physicalCodeKeyTokenFromInput(input)
  return isPunctuationKeyToken(physicalKey) ? physicalKey : null
}

function shouldUseSemanticPunctuation(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: Windows/Linux expose AltGr as Ctrl+Alt; don't turn international text input into Mod+Alt app shortcuts.
  if (
    getKeybindingPlatform(platform) !== 'darwin' &&
    parsed.mod &&
    parsed.alt &&
    hasModifier(input, 'control') &&
    hasModifier(input, 'alt') &&
    !hasModifier(input, 'meta') &&
    physicalPunctuationKey(input) === null
  ) {
    return false
  }
  return true
}

function keyMatches(
  parsedKey: string,
  input: KeybindingInput,
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): boolean {
  if (parsedKey.length === 1 && parsedKey >= 'A' && parsedKey <= 'Z') {
    return letterKeyMatches(input, parsedKey, parsed, platform)
  }
  if (parsedKey.length === 1 && parsedKey >= '0' && parsedKey <= '9') {
    return digitKeyMatches(input, parsedKey, platform)
  }

  if (parsedKey === 'NumpadAdd' || parsedKey === 'NumpadSubtract') {
    return (
      numpadCodeKeyTokenFromInput(input) === parsedKey ||
      logicalKeyTokenFromInput(input) === parsedKey
    )
  }

  if (isPunctuationKeyToken(parsedKey)) {
    // Why: shortcut labels name logical punctuation, but international layouts can report it from different physical codes.
    const semanticKey = semanticPunctuationKey(input)
    if (semanticKey !== null) {
      if (!shouldUseSemanticPunctuation(parsed, input, platform)) {
        return false
      }
      return semanticKey === parsedKey
    }
    return (
      (canFallBackToPhysicalCode(input, platform) ||
        shouldUseMacOptionPunctuationPhysicalFallback(parsed, input, platform)) &&
      physicalPunctuationKey(input) === parsedKey
    )
  }

  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey !== null) {
    return logicalKey === parsedKey
  }
  return (
    canFallBackToPhysicalCode(input, platform) && physicalCodeKeyTokenFromInput(input) === parsedKey
  )
}

function resolveModifierToken(
  modifier: ModifierToken,
  platform: NodeJS.Platform
): 'meta' | 'control' | 'alt' | 'shift' {
  switch (modifier) {
    case 'Mod':
      return platform === 'darwin' ? 'meta' : 'control'
    case 'Cmd':
      return 'meta'
    case 'Ctrl':
      return 'control'
    case 'Alt':
      return 'alt'
    case 'Shift':
      return 'shift'
  }
}

export function keybindingMatchesInput(
  binding: string,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return false
  }
  // A double-tap binding matches only a synthetic double-tap input (and vice-versa), resolved per platform.
  if (parsed.doubleTapModifier) {
    return (
      input.doubleTapModifier !== undefined &&
      resolveModifierToken(parsed.doubleTapModifier, platform) ===
        resolveModifierToken(input.doubleTapModifier, platform)
    )
  }
  if (input.doubleTapModifier !== undefined) {
    return false
  }
  return (
    modifierStateMatches(parsed, input, platform) && keyMatches(parsed.key, input, parsed, platform)
  )
}

function keybindingConflictIdentityForParsed(
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): string {
  if (parsed.doubleTapModifier) {
    return `DoubleTap:${resolveModifierToken(parsed.doubleTapModifier, platform)}`
  }
  const modifiers = platformModifiers(parsed, platform)
  return [
    modifiers.meta ? 'Meta' : '',
    modifiers.control ? 'Control' : '',
    modifiers.alt ? 'Alt' : '',
    modifiers.shift ? 'Shift' : '',
    parsed.key
  ].join('+')
}

function keybindingConflictIdentity(binding: string, platform: NodeJS.Platform): string {
  const parsed = parseKeybinding(binding)
  return parsed ? keybindingConflictIdentityForParsed(parsed, platform) : binding
}

function keybindingConflictIdentities(
  actionId: KeybindingActionId,
  binding: string,
  platform: NodeJS.Platform
): readonly string[] {
  const exact = keybindingConflictIdentity(binding, platform)
  if (!isDigitIndexActionId(actionId)) {
    return [exact]
  }
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
    return [exact]
  }
  return Array.from({ length: 9 }, (_, index) =>
    keybindingConflictIdentityForParsed({ ...parsed, key: String(index + 1) }, platform)
  )
}

export function keybindingMatchesAction(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): boolean {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  if (!definition) {
    return false
  }
  if (!keybindingIsActiveInContext(definition, options)) {
    return false
  }
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).some((binding) =>
    keybindingMatchesInput(binding, input, platform)
  )
}

function digitFromInput(input: KeybindingInput, platform: NodeJS.Platform): string | null {
  for (let value = 1; value <= 9; value++) {
    const digit = String(value)
    if (digitKeyMatches(input, digit, platform)) {
      return digit
    }
  }
  return null
}

// Why: a digit-index row's representative chord fires for any 1-9 — reuse its modifiers with the pressed digit via the normal matcher.
export function matchKeybindingDigitIndex(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): number | null {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  if (!definition || !keybindingIsActiveInContext(definition, options)) {
    return null
  }
  const digit = digitFromInput(input, platform)
  if (!digit) {
    return null
  }
  for (const binding of getEffectiveKeybindingsForAction(actionId, platform, overrides)) {
    const parsed = parseKeybinding(binding)
    if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
      continue
    }
    const candidate = canonicalizeParsedKeybinding({ ...parsed, key: digit })
    if (keybindingMatchesInput(candidate, input, platform)) {
      return Number(digit) - 1
    }
  }
  return null
}

function formatModifierGlyph(modifier: ModifierToken, isMac: boolean): string {
  switch (modifier) {
    case 'Mod':
      return isMac ? '⌘' : 'Ctrl'
    case 'Cmd':
      return isMac ? '⌘' : 'Cmd'
    case 'Ctrl':
      return isMac ? '⌃' : 'Ctrl'
    case 'Alt':
      return isMac ? '⌥' : 'Alt'
    case 'Shift':
      return isMac ? '⇧' : 'Shift'
  }
}

export function formatKeybinding(binding: string, platform: NodeJS.Platform): string[] {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return [binding]
  }
  const isMac = platform === 'darwin'
  if (parsed.doubleTapModifier) {
    const glyph = formatModifierGlyph(parsed.doubleTapModifier, isMac)
    return [glyph, glyph]
  }
  const parts: string[] = []
  if (parsed.mod) {
    parts.push(isMac ? '⌘' : 'Ctrl')
  }
  if (parsed.meta) {
    parts.push(isMac ? '⌘' : 'Cmd')
  }
  if (parsed.control) {
    parts.push(isMac ? '⌃' : 'Ctrl')
  }
  if (parsed.alt) {
    parts.push(isMac ? '⌥' : 'Alt')
  }
  if (parsed.shift) {
    parts.push(isMac ? '⇧' : 'Shift')
  }
  parts.push(formatKeyToken(parsed.key))
  return parts
}

export function formatKeybindingList(
  bindings: readonly string[],
  platform: NodeJS.Platform
): string {
  if (bindings.length === 0) {
    return 'Unassigned'
  }
  return bindings
    .map((binding) => {
      const separator = isDoubleTapBinding(binding) ? ' ' : platform === 'darwin' ? '' : '+'
      return formatKeybinding(binding, platform).join(separator)
    })
    .join(', ')
}

function formatKeyToken(token: string): string {
  const labels: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Underscore: '_',
    Equal: '=',
    Plus: '+',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    NumpadAdd: 'Numpad +',
    NumpadSubtract: 'Numpad -',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Tab: 'Tab',
    Escape: 'Esc',
    Space: 'Space'
  }
  return labels[token] ?? token
}

export function findKeybindingConflicts(
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: FindKeybindingConflictOptions = {}
): KeybindingConflict[] {
  const owners = new Map<string, { binding: string; actionIds: Set<KeybindingActionId> }>()
  const ignoredActionIds = new Set(options.ignoredActionIds ?? [])
  const customizedActions = new Set(
    Object.keys(overrides ?? {}).filter(
      (actionId): actionId is KeybindingActionId =>
        isKeybindingActionId(actionId) && !ignoredActionIds.has(actionId)
    )
  )
  for (const definition of KEYBINDING_DEFINITIONS) {
    if (ignoredActionIds.has(definition.id)) {
      continue
    }
    for (const binding of getEffectiveKeybindingsForAction(definition.id, platform, overrides)) {
      const groups = new Set([definition.conflictGroup ?? definition.scope])
      if (definition.conflictGroup) {
        // Why: native menu accelerators can consume global chords, so check custom bindings against both the menu bucket and scope.
        groups.add(definition.scope)
      }
      for (const group of groups) {
        for (const identity of keybindingConflictIdentities(definition.id, binding, platform)) {
          const conflictKey = `${group}\u0000${identity}`
          const current = owners.get(conflictKey) ?? { binding, actionIds: new Set() }
          if (
            !isDigitIndexActionId(definition.id) &&
            Array.from(current.actionIds).some((actionId) => isDigitIndexActionId(actionId))
          ) {
            current.binding = binding
          }
          current.actionIds.add(definition.id)
          owners.set(conflictKey, current)
        }
      }
    }
  }

  const seenConflictKeys = new Set<string>()
  return Array.from(owners.values())
    .filter(({ actionIds }) => actionIds.size > 1 && setIntersects(actionIds, customizedActions))
    .map(({ binding, actionIds }) => ({
      binding,
      actionIds: Array.from(actionIds)
    }))
    .filter((conflict) => {
      const key = `${conflict.binding}\u0000${conflict.actionIds.join('\u0000')}`
      if (seenConflictKeys.has(key)) {
        return false
      }
      seenConflictKeys.add(key)
      return true
    })
}

function setIntersects<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true
    }
  }
  return false
}
