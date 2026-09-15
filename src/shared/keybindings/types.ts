import type { TuiAgent } from '../tui-agent'

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
export type PluginKeybindingActionId = `plugin:${string}`

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
  | 'dashboard.toggle'
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
  | 'editor.toggleWordWrap'
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
  | 'terminal.selectAll'
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
  | PluginKeybindingActionId

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

export type PlatformBindings = {
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

export type ParsedKeybinding = {
  mod: boolean
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  key: string
  doubleTapModifier?: ModifierToken
}

export type NormalizeKeybindingOptions = {
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
  relevantActionIds?: Iterable<KeybindingActionId>
}
