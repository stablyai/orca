/* eslint-disable max-lines -- Why: the central shortcut registry, parser,
 * formatter, and conflict detector must stay in one shared module so main,
 * renderer, browser guests, and Settings cannot drift apart. */
export type KeybindingScope =
  | 'global'
  | 'tabs'
  | 'terminal'
  | 'browser'
  | 'editor'
  | 'fileExplorer'
  | 'composer'
  | 'settings'
  | 'onboarding'

export type KeybindingContext = 'app' | 'terminal' | 'browser'

export type KeybindingPlatform = 'darwin' | 'linux' | 'win32'

export type TerminalShortcutPolicy = 'orca-first' | 'terminal-first'

export type KeybindingMatchOptions = {
  context?: KeybindingContext
  terminalShortcutPolicy?: TerminalShortcutPolicy
}

export type KeybindingActionId =
  | 'worktree.quickOpen'
  | 'worktree.palette'
  | 'worktree.navigateUp'
  | 'worktree.navigateDown'
  | 'app.settings'
  | 'app.forceReload'
  | 'file.exportPdf'
  | 'workspace.create'
  | 'voice.dictation'
  | 'view.tasks'
  | 'sidebar.left.toggle'
  | 'sidebar.right.toggle'
  | 'sidebar.explorer.toggle'
  | 'sidebar.search.toggle'
  | 'sidebar.sourceControl.toggle'
  | 'sidebar.checks.toggle'
  | 'sidebar.ports.toggle'
  | 'sidebar.focusWorktreeList'
  | 'floatingTerminal.toggle'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset'
  | 'worktree.history.back'
  | 'worktree.history.forward'
  | 'tab.newTerminal'
  | 'tab.newBrowser'
  | 'tab.newMarkdown'
  | 'tab.close'
  | 'tab.reopenClosed'
  | 'tab.nextSameType'
  | 'tab.previousSameType'
  | 'tab.nextAllTypes'
  | 'tab.previousAllTypes'
  | 'tab.previousRecent'
  | 'tab.nextTerminal'
  | 'tab.previousTerminal'
  | 'browser.find'
  | 'browser.reload'
  | 'browser.hardReload'
  | 'browser.focusAddressBar'
  | 'browser.grabElement'
  | 'editor.find'
  | 'editor.save'
  | 'editor.markdownPreview'
  | 'editor.copyContext'
  | 'fileExplorer.copyPath'
  | 'fileExplorer.copyRelativePath'
  | 'fileExplorer.delete'
  | 'composer.addAttachment'
  | 'composer.submit'
  | 'settings.search'
  | 'onboarding.continue'
  | 'terminal.copySelection'
  | 'terminal.paste'
  | 'terminal.search'
  | 'terminal.clear'
  | 'terminal.focusNextPane'
  | 'terminal.focusPreviousPane'
  | 'terminal.expandPane'
  | 'terminal.closePane'
  | 'terminal.splitRight'
  | 'terminal.splitDown'

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
  conflictGroup?: string
}

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
}

type ParsedKeybinding = {
  mod: boolean
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  key: string
}

type NormalizeKeybindingOptions = {
  allowBareKeybindings?: boolean
}

export type KeybindingValidationResult = { ok: true; value: string } | { ok: false; error: string }

export type KeybindingConflict = {
  binding: string
  actionIds: KeybindingActionId[]
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
    id: 'file.exportPdf',
    title: 'Export as PDF',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'export', 'pdf', 'markdown'],
    defaultBindings: platformBindings(['Mod+Shift+E']),
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
    id: 'sidebar.focusWorktreeList',
    title: 'Focus worktree list',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'sidebar', 'worktree', 'focus'],
    defaultBindings: platformBindings(['Mod+0'])
  },
  {
    id: 'floatingTerminal.toggle',
    title: 'Toggle Floating Terminal',
    group: 'Global',
    scope: 'global',
    searchKeywords: ['shortcut', 'floating terminal', 'terminal'],
    defaultBindings: platformBindings(['Mod+Alt+T']),
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
    id: 'tab.newBrowser',
    title: 'New browser tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'browser', 'new'],
    defaultBindings: platformBindings(['Mod+Shift+B'])
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
    id: 'tab.close',
    title: 'Close active tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'close', 'tab', 'pane'],
    defaultBindings: platformBindings(['Mod+W'])
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
    defaultBindings: platformBindings(['Mod+Shift+BracketRight'])
  },
  {
    id: 'tab.previousSameType',
    title: 'Previous tab (same type)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'previous', 'switch', 'cycle'],
    defaultBindings: platformBindings(['Mod+Shift+BracketLeft'])
  },
  {
    id: 'tab.nextAllTypes',
    title: 'Next tab (all types)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'next', 'switch', 'cycle', 'all', 'any'],
    defaultBindings: platformBindings(['Mod+Alt+BracketRight'])
  },
  {
    id: 'tab.previousAllTypes',
    title: 'Previous tab (all types)',
    group: 'Tab Navigation',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'previous', 'switch', 'cycle', 'all', 'any'],
    defaultBindings: platformBindings(['Mod+Alt+BracketLeft'])
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
    id: 'browser.find',
    title: 'Find in Browser',
    group: 'Browser',
    scope: 'browser',
    searchKeywords: ['shortcut', 'browser', 'find', 'search'],
    defaultBindings: platformBindings(['Mod+F'])
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
    id: 'composer.addAttachment',
    title: 'Add Attachment',
    group: 'Composer',
    scope: 'composer',
    searchKeywords: ['shortcut', 'composer', 'attachment', 'upload'],
    defaultBindings: platformBindings(['Mod+U'])
  },
  {
    id: 'composer.submit',
    title: 'Submit Composer',
    group: 'Composer',
    scope: 'composer',
    searchKeywords: ['shortcut', 'composer', 'submit', 'send', 'comment'],
    defaultBindings: platformBindings(['Mod+Enter'])
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
    id: 'onboarding.continue',
    title: 'Continue Onboarding',
    group: 'Onboarding',
    scope: 'onboarding',
    searchKeywords: ['shortcut', 'onboarding', 'continue', 'next'],
    defaultBindings: platformBindings(['Mod+Enter'])
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
    id: 'terminal.expandPane',
    title: 'Expand / collapse pane',
    group: 'Terminal Panes',
    scope: 'terminal',
    searchKeywords: ['shortcut', 'pane', 'expand', 'collapse'],
    defaultBindings: platformBindings(['Mod+Shift+Enter'])
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
  }
]

const DEFINITIONS_BY_ID = new Map<KeybindingActionId, KeybindingDefinition>(
  KEYBINDING_DEFINITIONS.map((definition) => [definition.id, definition])
)

const DEFINITION_IDS = new Set<KeybindingActionId>(
  KEYBINDING_DEFINITIONS.map((definition) => definition.id)
)

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

function normalizeKeyToken(token: string): string | null {
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

function parseKeybinding(binding: string): ParsedKeybinding | null {
  const rawParts = binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (rawParts.length === 0) {
    return null
  }

  const parsed: ParsedKeybinding = {
    mod: false,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    key: ''
  }

  for (const rawPart of rawParts) {
    const part = rawPart.toLowerCase()
    if (part === 'mod' || part === 'cmdorctrl' || part === 'commandorcontrol') {
      parsed.mod = true
      continue
    }
    if (part === 'cmd' || part === 'command' || part === 'meta' || rawPart === '⌘') {
      parsed.meta = true
      continue
    }
    if (part === 'ctrl' || part === 'control' || rawPart === '⌃') {
      parsed.control = true
      continue
    }
    if (part === 'alt' || part === 'option' || part === 'opt' || rawPart === '⌥') {
      parsed.alt = true
      continue
    }
    if (part === 'shift' || rawPart === '⇧') {
      parsed.shift = true
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
  if (parsed.shift || parsed.mod || parsed.meta || parsed.control || parsed.alt) {
    return false
  }
  return [
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
  const isShiftInsert = parsed.shift && parsed.key === 'Insert'
  const isBareAllowed = options.allowBareKeybindings === true && isSafeBareKey(parsed)
  if (
    !parsed.mod &&
    !parsed.meta &&
    !parsed.control &&
    !parsed.alt &&
    !isShiftInsert &&
    !isBareAllowed
  ) {
    return { ok: false, error: 'Include at least one modifier key.' }
  }
  return { ok: true, value: canonicalizeParsedKeybinding(parsed) }
}

export function normalizeKeybinding(binding: string): KeybindingValidationResult {
  return normalizeKeybindingWithOptions(binding)
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

export function normalizeKeybindingArray(
  input: readonly string[]
): KeybindingValidationResult | string[] {
  return normalizeKeybindingArrayWithOptions(input)
}

function normalizeOptionsForAction(actionId: KeybindingActionId): NormalizeKeybindingOptions {
  return {
    allowBareKeybindings: DEFINITIONS_BY_ID.get(actionId)?.allowBareKeybindings === true
  }
}

export function normalizeKeybindingListForAction(
  actionId: KeybindingActionId,
  input: string
): KeybindingValidationResult | string[] {
  return normalizeKeybindingListWithOptions(input, normalizeOptionsForAction(actionId))
}

export function normalizeKeybindingArrayForAction(
  actionId: KeybindingActionId,
  input: readonly string[]
): KeybindingValidationResult | string[] {
  return normalizeKeybindingArrayWithOptions(input, normalizeOptionsForAction(actionId))
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

function keyTokenFromInput(input: KeybindingInput): string | null {
  const code = input.code ?? ''
  const key = input.key ?? ''

  if (MODIFIER_KEYS.has(key)) {
    return null
  }
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toUpperCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5)
  }

  return normalizeKeyToken(key) ?? normalizeKeyToken(code)
}

function keybindingFromInputWithOptions(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult {
  const key = keyTokenFromInput(input)
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
  return keybindingFromInputWithOptions(input, platform, normalizeOptionsForAction(actionId))
}

function getDefaultBindings(definition: KeybindingDefinition, platform: NodeJS.Platform): string[] {
  return definition.defaultBindings[getKeybindingPlatform(platform)].map((binding) => {
    const normalized = normalizeKeybindingWithOptions(binding, {
      allowBareKeybindings: definition.allowBareKeybindings === true
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
  // Why: Orca-first preserves existing app shortcut behavior inside terminals.
  // Terminal-first is the explicit escape hatch for shells and TUIs.
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

function letterKeyMatches(input: KeybindingInput, letter: string): boolean {
  const key = (input.key ?? '').toLowerCase()
  if (key.length === 1 && key >= 'a' && key <= 'z') {
    return key === letter.toLowerCase()
  }
  return input.code === `Key${letter.toUpperCase()}`
}

function keyMatches(parsedKey: string, input: KeybindingInput): boolean {
  if (parsedKey.length === 1 && parsedKey >= 'A' && parsedKey <= 'Z') {
    return letterKeyMatches(input, parsedKey)
  }
  if (parsedKey.length === 1 && parsedKey >= '0' && parsedKey <= '9') {
    return input.key === parsedKey || input.code === `Digit${parsedKey}`
  }

  const key = input.key ?? ''
  const code = input.code ?? ''
  switch (parsedKey) {
    case 'BracketLeft':
      return code === 'BracketLeft'
    case 'BracketRight':
      return code === 'BracketRight'
    case 'Minus':
      // Why: shifted "_" is terminal undo/readline input. Users who want it
      // as zoom-out can bind it explicitly instead of having the default steal it.
      return key === '-' || key === 'Minus' || code === 'Minus'
    case 'Underscore':
      return key === '_' || key === 'Underscore'
    case 'Equal':
      return key === '=' || key === 'Equal' || code === 'Equal'
    case 'Plus':
      return key === '+' || key === 'Plus'
    case 'NumpadAdd':
      return code === 'NumpadAdd' || key === 'Add'
    case 'NumpadSubtract':
      return code === 'NumpadSubtract' || key === 'Subtract'
    case 'Enter':
      return key === 'Enter' && (code === 'Enter' || code === 'NumpadEnter' || code === '')
    default:
      return key === parsedKey || code === parsedKey
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
  return modifierStateMatches(parsed, input, platform) && keyMatches(parsed.key, input)
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

export function formatKeybinding(binding: string, platform: NodeJS.Platform): string[] {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return [binding]
  }
  const isMac = platform === 'darwin'
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
    .map((binding) => formatKeybinding(binding, platform).join(platform === 'darwin' ? '' : '+'))
    .join(', ')
}

export function formatElectronAccelerator(binding: string): string | null {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return null
  }
  const parts: string[] = []
  if (parsed.mod) {
    parts.push('CmdOrCtrl')
  }
  if (parsed.meta) {
    parts.push('Command')
  }
  if (parsed.control) {
    parts.push('Control')
  }
  if (parsed.alt) {
    parts.push('Alt')
  }
  if (parsed.shift) {
    parts.push('Shift')
  }
  parts.push(formatElectronKeyToken(parsed.key))
  return parts.join('+')
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

function formatElectronKeyToken(token: string): string {
  const labels: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Underscore: '_',
    Equal: '=',
    Plus: 'Plus',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    Escape: 'Esc',
    Space: 'Space'
  }
  return labels[token] ?? token
}

export function findKeybindingConflicts(
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): KeybindingConflict[] {
  const owners = new Map<string, KeybindingActionId[]>()
  const customizedActions = new Set(
    Object.keys(overrides ?? {}).filter((actionId): actionId is KeybindingActionId =>
      isKeybindingActionId(actionId)
    )
  )
  for (const definition of KEYBINDING_DEFINITIONS) {
    for (const binding of getEffectiveKeybindingsForAction(definition.id, platform, overrides)) {
      const groups = new Set([definition.conflictGroup ?? definition.scope])
      if (definition.conflictGroup) {
        // Why: native menu accelerators can still consume global chords, so custom
        // renderer bindings must be checked against both the menu bucket and scope.
        groups.add(definition.scope)
      }
      for (const group of groups) {
        const conflictKey = `${group}\u0000${binding}`
        const current = owners.get(conflictKey) ?? []
        current.push(definition.id)
        owners.set(conflictKey, current)
      }
    }
  }

  return Array.from(owners.entries())
    .filter(
      ([, actionIds]) =>
        actionIds.length > 1 && actionIds.some((actionId) => customizedActions.has(actionId))
    )
    .map(([conflictKey, actionIds]) => ({
      binding: conflictKey.slice(conflictKey.indexOf('\u0000') + 1),
      actionIds
    }))
}

export function getDefaultKeybindingOverrides(): KeybindingOverrides {
  return {}
}
