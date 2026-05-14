export type KeybindingPlatform = 'macos' | 'linux' | 'windows'

export type ShortcutSurface =
  | 'mainWindow'
  | 'browserGuest'
  | 'terminal'
  | 'terminalClipboardBypass'
  | 'menu'
  | 'settings'

export type KeybindingActionId =
  | 'terminal.paste'
  | 'terminal.copySelection'
  | 'terminal.copySelectionIfSelected'
  | 'terminal.search.toggle'
  | 'terminal.clear'
  | 'terminal.focusPreviousPane'
  | 'terminal.focusNextPane'
  | 'terminal.expandActivePane.toggle'
  | 'terminal.closeActivePane'
  | 'terminal.splitPane.vertical'
  | 'terminal.splitPane.horizontal'
  | 'terminal.input.shiftEnter'
  | 'terminal.input.deleteWordLeft'
  | 'terminal.input.deleteLineLeft'
  | 'terminal.input.deleteLineRight'
  | 'terminal.input.lineStart'
  | 'terminal.input.lineEnd'
  | 'terminal.input.wordLeft'
  | 'terminal.input.wordRight'
  | 'terminal.input.wordDeleteRight'
  | 'terminal.tab.new'
  | 'terminal.tab.switch.next'
  | 'terminal.tab.switch.previous'
  | 'browser.tab.new'
  | 'browser.addressBar.focus'
  | 'browser.find.open'
  | 'browser.page.reload'
  | 'browser.page.hardReload'
  | 'browser.grabMode.toggle'
  | 'editor.file.save'
  | 'editor.file.newMarkdown'
  | 'tab.closeActive'
  | 'tab.reopenClosed'
  | 'tab.switch.next'
  | 'tab.switch.previous'
  | 'tab.switchAll.next'
  | 'tab.switchAll.previous'
  | 'window.zoomIn'
  | 'window.zoomOut'
  | 'window.zoomReset'
  | 'worktree.palette.toggle'
  | 'terminal.floating.toggle'
  | 'sidebar.left.toggle'
  | 'sidebar.right.toggle'
  | 'quickOpen.open'
  | 'workspace.new.open'
  | 'worktree.history.back'
  | 'worktree.history.forward'
  | `worktree.jump.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export type KeybindingCommand =
  | { type: 'terminalPaste' }
  | { type: 'terminalCopySelection' }
  | { type: 'terminalCopySelectionIfSelected' }
  | { type: 'terminalToggleSearch' }
  | { type: 'terminalClearActivePane' }
  | { type: 'terminalFocusPane'; direction: 'previous' | 'next' }
  | { type: 'terminalToggleExpandActivePane' }
  | { type: 'terminalCloseActivePane' }
  | { type: 'terminalSplitActivePane'; direction: 'vertical' | 'horizontal' }
  | { type: 'terminalSendInput'; data: string }
  | { type: 'openNewTerminalTab' }
  | { type: 'switchTerminalTab'; direction: 'next' | 'previous' }
  | { type: 'openNewBrowserTab' }
  | { type: 'focusBrowserAddressBar' }
  | { type: 'findInBrowserPage' }
  | { type: 'reloadBrowserPage' }
  | { type: 'hardReloadBrowserPage' }
  | { type: 'toggleBrowserGrabMode' }
  | { type: 'saveActiveEditorFile' }
  | { type: 'openNewMarkdownFile' }
  | { type: 'closeActiveTab' }
  | { type: 'reopenClosedTab' }
  | { type: 'switchTab'; direction: 'next' | 'previous' }
  | { type: 'switchTabAcrossAllTypes'; direction: 'next' | 'previous' }
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  | { type: 'toggleWorktreePalette' }
  | { type: 'toggleFloatingTerminal' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'toggleRightSidebar' }
  | { type: 'openQuickOpen' }
  | { type: 'openNewWorkspace' }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }

export type KeybindingEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  defaultPrevented?: boolean
}

export type CanonicalChord = {
  key: string
  cmd: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type KeybindingCatalogEntry = {
  id: KeybindingActionId
  title: string
  surfaces: ShortcutSurface[]
  defaults: Partial<Record<KeybindingPlatform, string[]>>
  command: KeybindingCommand
  allowRepeat?: boolean
}

export type KeybindingDiagnosticCode =
  | 'unknown-action'
  | 'invalid-chord'
  | 'invalid-value'
  | 'conflict'

export type KeybindingDiagnostic = {
  code: KeybindingDiagnosticCode
  actionId?: string
  chord?: string
  message: string
}

export type UserKeybindingOverrideValue = string | string[] | 'none'

export type UserKeybindingOverrides = Record<string, UserKeybindingOverrideValue>

export type EffectiveKeybinding = {
  id: KeybindingActionId
  title: string
  surfaces: ShortcutSurface[]
  chords: CanonicalChord[]
  command: KeybindingCommand
  source: 'default' | 'user' | 'unbound'
  allowRepeat: boolean
}

export type EffectiveKeymap = {
  platform: KeybindingPlatform
  bindings: EffectiveKeybinding[]
  diagnostics: KeybindingDiagnostic[]
}

export type UserKeybindingFileState = 'missing' | 'loaded' | 'unreadable' | 'malformed'

export type KeybindingSnapshot = {
  configPath: string
  displayPath: string
  fileState: UserKeybindingFileState
  keymap: EffectiveKeymap
  loadedAt: number
}
