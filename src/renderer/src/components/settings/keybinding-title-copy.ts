import {
  agentTabActionId,
  type AgentTabActionId,
  type KeybindingActionId,
  type KeybindingDefinition,
  type PluginKeybindingActionId
} from '../../../../shared/keybindings'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { translate } from '@/i18n/i18n'
import { uniqueKeywords } from './settings-search-keywords'

type StaticKeybindingActionId = Exclude<
  KeybindingActionId,
  AgentTabActionId | PluginKeybindingActionId
>

// Literal keys keep extraction and coverage gates aware of every shortcut title.
const STATIC_TITLE_COPY = {
  'worktree.quickOpen': () => translate('keybindings.title.worktreeQuickOpen', 'Go to File'),
  'app.settings': () => translate('keybindings.title.appSettings', 'Open Settings'),
  'app.forceReload': () => translate('keybindings.title.appForceReload', 'Force Reload'),
  'worktree.palette': () => translate('keybindings.title.worktreePalette', 'Switch worktree'),
  'worktree.navigateUp': () =>
    translate('keybindings.title.worktreeNavigateUp', 'Previous worktree'),
  'worktree.navigateDown': () =>
    translate('keybindings.title.worktreeNavigateDown', 'Next worktree'),
  'workspace.create': () => translate('keybindings.title.workspaceCreate', 'Create worktree'),
  'workspace.rename': () => translate('keybindings.title.workspaceRename', 'Rename worktree'),
  'workspace.delete': () => translate('keybindings.title.workspaceDelete', 'Delete Workspace'),
  'workspace.openBoard': () =>
    translate('keybindings.title.workspaceOpenBoard', 'Toggle Workspace Board'),
  'dashboard.toggle': () =>
    translate('keybindings.title.dashboardToggle', 'Toggle Agent Dashboard'),
  'workspace.selectByIndex': () =>
    translate('keybindings.title.workspaceSelectByIndex', 'Select Workspace 1–9'),
  'voice.dictation': () => translate('keybindings.title.voiceDictation', 'Dictation'),
  'voice.control': () => translate('keybindings.title.voiceControl', 'Voice Control'),
  'view.tasks': () => translate('keybindings.title.viewTasks', 'Open Tasks'),
  'sidebar.left.toggle': () => translate('keybindings.title.sidebarLeftToggle', 'Toggle Sidebar'),
  'sidebar.right.toggle': () =>
    translate('keybindings.title.sidebarRightToggle', 'Toggle Right Sidebar'),
  'sidebar.explorer.toggle': () =>
    translate('keybindings.title.sidebarExplorerToggle', 'Show Explorer'),
  'sidebar.search.toggle': () => translate('keybindings.title.sidebarSearchToggle', 'Show Search'),
  'sidebar.sourceControl.toggle': () =>
    translate('keybindings.title.sidebarSourceControlToggle', 'Show Source Control'),
  'sidebar.checks.toggle': () => translate('keybindings.title.sidebarChecksToggle', 'Show Checks'),
  'sidebar.ports.toggle': () => translate('keybindings.title.sidebarPortsToggle', 'Show Ports'),
  'sidebar.sleepingWorkspaces.toggle': () =>
    translate('keybindings.title.sidebarSleepingWorkspacesToggle', 'Toggle Sleeping Workspaces'),
  'sidebar.focusWorktreeList': () =>
    translate('keybindings.title.sidebarFocusWorktreeList', 'Focus worktree list'),
  'floatingTerminal.toggle': () =>
    translate('keybindings.title.floatingTerminalToggle', 'Toggle Floating Terminal'),
  'floatingWorkspace.maximize': () =>
    translate('keybindings.title.floatingWorkspaceMaximize', 'Maximize Floating Workspace Panel'),
  'floatingWorkspace.minimize': () =>
    translate('keybindings.title.floatingWorkspaceMinimize', 'Minimize Floating Workspace Panel'),
  'zoom.in': () => translate('keybindings.title.zoomIn', 'Zoom In'),
  'zoom.out': () => translate('keybindings.title.zoomOut', 'Zoom Out'),
  'zoom.reset': () => translate('keybindings.title.zoomReset', 'Reset Size'),
  'worktree.history.back': () =>
    translate('keybindings.title.worktreeHistoryBack', 'Worktree History Back'),
  'worktree.history.forward': () =>
    translate('keybindings.title.worktreeHistoryForward', 'Worktree History Forward'),
  'tab.newTerminal': () => translate('keybindings.title.tabNewTerminal', 'New terminal tab'),
  'tab.newAgent': () => translate('keybindings.title.tabNewAgent', 'New agent tab (default agent)'),
  'tab.newBrowser': () => translate('keybindings.title.tabNewBrowser', 'New browser tab'),
  'tab.newSimulator': () =>
    translate('keybindings.title.tabNewSimulator', 'New mobile emulator tab'),
  'tab.newMarkdown': () => translate('keybindings.title.tabNewMarkdown', 'New markdown tab'),
  'tab.openMarkdown': () => translate('keybindings.title.tabOpenMarkdown', 'Open markdown tab'),
  'tab.close': () => translate('keybindings.title.tabClose', 'Close active tab'),
  'tab.closeAll': () => translate('keybindings.title.tabCloseAll', 'Close all editor tabs'),
  'tab.rename': () => translate('keybindings.title.tabRename', 'Rename active tab'),
  'tab.reopenClosed': () => translate('keybindings.title.tabReopenClosed', 'Reopen closed tab'),
  'tab.nextSameType': () => translate('keybindings.title.tabNextSameType', 'Next tab (same type)'),
  'tab.previousSameType': () =>
    translate('keybindings.title.tabPreviousSameType', 'Previous tab (same type)'),
  'tab.nextAllTypes': () => translate('keybindings.title.tabNextAllTypes', 'Next tab (all types)'),
  'tab.previousAllTypes': () =>
    translate('keybindings.title.tabPreviousAllTypes', 'Previous tab (all types)'),
  'tab.previousRecent': () =>
    translate('keybindings.title.tabPreviousRecent', 'Previous recent tab'),
  'tab.nextTerminal': () => translate('keybindings.title.tabNextTerminal', 'Next terminal tab'),
  'tab.previousTerminal': () =>
    translate('keybindings.title.tabPreviousTerminal', 'Previous terminal tab'),
  'tab.selectByIndex': () => translate('keybindings.title.tabSelectByIndex', 'Select Tab 1–9'),
  'tab.openQuickCommandsMenu': () =>
    translate('keybindings.title.tabOpenQuickCommandsMenu', 'Toggle Quick Commands menu'),
  'browser.find': () => translate('keybindings.title.browserFind', 'Find in Browser'),
  'browser.back': () => translate('keybindings.title.browserBack', 'Go Back in Browser'),
  'browser.forward': () => translate('keybindings.title.browserForward', 'Go Forward in Browser'),
  'browser.showHistory': () =>
    translate('keybindings.title.browserShowHistory', 'Show Browser History'),
  'browser.reload': () => translate('keybindings.title.browserReload', 'Reload Browser Page'),
  'browser.hardReload': () =>
    translate('keybindings.title.browserHardReload', 'Hard Reload Browser Page'),
  'browser.focusAddressBar': () =>
    translate('keybindings.title.browserFocusAddressBar', 'Focus Browser Address Bar'),
  'browser.grabElement': () =>
    translate('keybindings.title.browserGrabElement', 'Grab Page Element'),
  'browser.annotateElement': () =>
    translate('keybindings.title.browserAnnotateElement', 'Annotate Page Element'),
  'editor.find': () => translate('keybindings.title.editorFind', 'Find in editor'),
  'editor.replace': () => translate('keybindings.title.editorReplace', 'Replace in editor'),
  'editor.save': () => translate('keybindings.title.editorSave', 'Save File'),
  'editor.markdownPreview': () =>
    translate('keybindings.title.editorMarkdownPreview', 'Show Markdown Preview'),
  'editor.toggleWordWrap': () =>
    translate('keybindings.title.editorToggleWordWrap', 'Toggle Word Wrap'),
  'editor.copyContext': () => translate('keybindings.title.editorCopyContext', 'Copy Context'),
  'editor.previousChange': () =>
    translate('keybindings.title.editorPreviousChange', 'Go to Previous Change'),
  'editor.nextChange': () => translate('keybindings.title.editorNextChange', 'Go to Next Change'),
  'editor.addReviewNote': () =>
    translate('keybindings.title.editorAddReviewNote', 'Add Review Note'),
  'sourceControl.sendReviewNotes': () =>
    translate('keybindings.title.sourceControlSendReviewNotes', 'Send Review Notes to Agent'),
  'fileExplorer.undo': () => translate('keybindings.title.fileExplorerUndo', 'Undo file operation'),
  'fileExplorer.redo': () => translate('keybindings.title.fileExplorerRedo', 'Redo file operation'),
  'fileExplorer.copyPath': () =>
    translate('keybindings.title.fileExplorerCopyPath', 'Copy file path'),
  'fileExplorer.copyRelativePath': () =>
    translate('keybindings.title.fileExplorerCopyRelativePath', 'Copy relative file path'),
  'fileExplorer.delete': () => translate('keybindings.title.fileExplorerDelete', 'Delete file'),
  'settings.search': () => translate('keybindings.title.settingsSearch', 'Search Settings'),
  'terminal.copySelection': () =>
    translate('keybindings.title.terminalCopySelection', 'Copy terminal selection'),
  'terminal.selectAll': () =>
    translate('keybindings.title.terminalSelectAll', 'Select all terminal text'),
  'terminal.paste': () => translate('keybindings.title.terminalPaste', 'Paste into terminal'),
  'terminal.search': () => translate('keybindings.title.terminalSearch', 'Search active pane'),
  'terminal.clear': () => translate('keybindings.title.terminalClear', 'Clear active pane'),
  'terminal.focusNextPane': () =>
    translate('keybindings.title.terminalFocusNextPane', 'Focus next pane'),
  'terminal.focusPreviousPane': () =>
    translate('keybindings.title.terminalFocusPreviousPane', 'Focus previous pane'),
  'terminal.equalizePaneSizes': () =>
    translate('keybindings.title.terminalEqualizePaneSizes', 'Equalize pane sizes'),
  'terminal.expandPane': () =>
    translate('keybindings.title.terminalExpandPane', 'Expand / collapse pane'),
  'terminal.setTitle': () => translate('keybindings.title.terminalSetTitle', 'Set Title…'),
  'chat.find': () => translate('keybindings.title.chatFind', 'Find in chat'),
  'terminal.toggleNativeChat': () =>
    translate('keybindings.title.terminalToggleNativeChat', 'Switch between Chat UI and terminal'),
  'sidebar.childWorkspaces.toggle': () =>
    translate('keybindings.title.sidebarChildWorkspacesToggle', 'Toggle Child Workspaces'),
  'terminal.clearPaneTitle': () =>
    translate('keybindings.title.terminalClearPaneTitle', 'Clear Pane Title'),
  'terminal.closePane': () => translate('keybindings.title.terminalClosePane', 'Close active pane'),
  'terminal.splitRight': () =>
    translate('keybindings.title.terminalSplitRight', 'Split terminal right'),
  'terminal.splitDown': () =>
    translate('keybindings.title.terminalSplitDown', 'Split terminal down'),
  'terminal.switchInputSource': () =>
    translate(
      'keybindings.title.terminalSwitchInputSource',
      'Switch input source / language (native)'
    )
} satisfies Record<StaticKeybindingActionId, () => string>

const GROUP_COPY = {
  Global: () => translate('keybindings.group.global', 'Global'),
  Tabs: () => translate('keybindings.group.tabs', 'Tabs'),
  'Tab Navigation': () => translate('keybindings.group.tabNavigation', 'Tab Navigation'),
  'Quick Commands': () => translate('keybindings.group.quickCommands', 'Quick Commands'),
  Browser: () => translate('keybindings.group.browser', 'Browser'),
  Editors: () => translate('keybindings.group.editors', 'Editors'),
  'File Explorer': () => translate('keybindings.group.fileExplorer', 'File Explorer'),
  Settings: () => translate('keybindings.group.settings', 'Settings'),
  'Terminal Panes': () => translate('keybindings.group.terminalPanes', 'Terminal Panes'),
  Chat: () => translate('keybindings.group.chat', 'Chat'),
  Agents: () => translate('keybindings.group.agents', 'Agents')
} satisfies Record<string, () => string>

const TITLE_COPY_BY_ID = new Map<string, () => string>([
  ...Object.entries(STATIC_TITLE_COPY),
  ...ALL_TUI_AGENTS.map((agent): [string, () => string] => [
    agentTabActionId(agent),
    () =>
      translate('keybindings.title.newAgentTab', 'New {{agent}} tab', {
        agent: TUI_AGENT_DISPLAY_NAMES[agent]
      })
  ])
])

const GROUP_COPY_BY_NAME = new Map<string, () => string>(Object.entries(GROUP_COPY))

// Plugin and unknown actions keep their registry title.
export function localizedKeybindingTitle(
  definition: Pick<KeybindingDefinition, 'id' | 'title'>
): string {
  return TITLE_COPY_BY_ID.get(definition.id)?.() ?? definition.title
}

export function localizedKeybindingGroup(group: string): string {
  return GROUP_COPY_BY_NAME.get(group)?.() ?? group
}

// English title and group stay searchable after localization.
export function localizeKeybindingDefinition(
  definition: KeybindingDefinition
): KeybindingDefinition {
  const title = localizedKeybindingTitle(definition)
  const group = localizedKeybindingGroup(definition.group)
  if (title === definition.title && group === definition.group) {
    return definition
  }
  return {
    ...definition,
    title,
    group,
    searchKeywords: uniqueKeywords([
      ...definition.searchKeywords,
      definition.title,
      definition.group
    ])
  }
}
