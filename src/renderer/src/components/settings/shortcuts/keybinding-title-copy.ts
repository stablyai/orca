import { agentTabActionId } from '../../../../../shared/keybindings/definitions'
import type {
  AgentTabActionId,
  KeybindingActionId,
  KeybindingDefinition,
  PluginKeybindingActionId
} from '../../../../../shared/keybindings/types'
import {
  ALL_TUI_AGENTS,
  TUI_AGENT_DISPLAY_NAMES
} from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { translate } from '@/i18n/i18n'
import { uniqueKeywords } from '../search/settings-search-keywords'

type StaticKeybindingActionId = Exclude<
  KeybindingActionId,
  AgentTabActionId | PluginKeybindingActionId
>

// Literal keys keep extraction and coverage gates aware of every shortcut title.
const STATIC_TITLE_COPY = {
  'worktree.quickOpen': () => translate('keybindings.title.1d1d2ec47b', 'Go to file'),
  'app.settings': () => translate('keybindings.title.e316152321', 'Open settings'),
  'app.forceReload': () => translate('keybindings.title.8a1982d598', 'Force reload'),
  'worktree.palette': () => translate('keybindings.title.worktreePalette', 'Switch worktree'),
  'worktree.navigateUp': () =>
    translate('keybindings.title.worktreeNavigateUp', 'Previous worktree'),
  'worktree.navigateDown': () =>
    translate('keybindings.title.worktreeNavigateDown', 'Next worktree'),
  'workspace.create': () => translate('keybindings.title.workspaceCreate', 'Create worktree'),
  'workspace.rename': () => translate('keybindings.title.workspaceRename', 'Rename worktree'),
  'workspace.delete': () => translate('keybindings.title.1d2c86248c', 'Delete workspace'),
  'workspace.openBoard': () => translate('keybindings.title.1524825c2c', 'Toggle workspace board'),
  'dashboard.toggle': () => translate('keybindings.title.82c1bf448c', 'Toggle agent dashboard'),
  'workspace.selectByIndex': () =>
    translate('keybindings.title.0feb1f0496', 'Select workspace 1–9'),
  'voice.dictation': () => translate('keybindings.title.voiceDictation', 'Dictation'),
  'view.tasks': () => translate('keybindings.title.81bcb6ec24', 'Open tasks'),
  'view.plugins': () => translate('keybindings.title.5c1a9f83e0', 'Open plugins'),
  'sidebar.left.toggle': () => translate('keybindings.title.196b416429', 'Toggle sidebar'),
  'sidebar.projects.toggleCollapse': () =>
    translate('keybindings.title.5468defe61', 'Collapse / expand all projects'),
  'sidebar.right.toggle': () => translate('keybindings.title.e0d7e6b665', 'Toggle right sidebar'),
  'sidebar.explorer.toggle': () =>
    translate('keybindings.title.sidebarExplorerToggle', 'Show Explorer'),
  'sidebar.search.toggle': () => translate('keybindings.title.da4e681113', 'Show search'),
  'sidebar.sourceControl.toggle': () =>
    translate('keybindings.title.44e8b7dcb5', 'Show source control'),
  'sidebar.checks.toggle': () => translate('keybindings.title.e37b19864c', 'Show checks'),
  'sidebar.ports.toggle': () => translate('keybindings.title.cb816639bd', 'Show ports'),
  'sidebar.sleepingWorkspaces.toggle': () =>
    translate('keybindings.title.437260810f', 'Toggle sleeping workspaces'),
  'sidebar.focusWorktreeList': () =>
    translate('keybindings.title.sidebarFocusWorktreeList', 'Focus worktree list'),
  'floatingTerminal.toggle': () =>
    translate('keybindings.title.e67a41569d', 'Toggle floating terminal'),
  'floatingWorkspace.maximize': () =>
    translate('keybindings.title.3e3a2d18d4', 'Maximize floating workspace panel'),
  'floatingWorkspace.minimize': () =>
    translate('keybindings.title.746ff0c872', 'Minimize floating workspace panel'),
  'zoom.in': () => translate('keybindings.title.f233164080', 'Zoom in'),
  'zoom.out': () => translate('keybindings.title.2b20f1f14a', 'Zoom out'),
  'zoom.reset': () => translate('keybindings.title.bb3beaeef6', 'Reset size'),
  'worktree.history.back': () => translate('keybindings.title.02dd0f77a0', 'Worktree history back'),
  'worktree.history.forward': () =>
    translate('keybindings.title.57c4fb0edd', 'Worktree history forward'),
  'tab.newTerminal': () => translate('keybindings.title.tabNewTerminal', 'New terminal tab'),
  'tab.newAgent': () => translate('keybindings.title.tabNewAgent', 'New agent tab (default agent)'),
  'tab.newBrowser': () => translate('keybindings.title.tabNewBrowser', 'New browser tab'),
  'tab.newBrowserSplitRight': () =>
    translate('keybindings.title.tabNewBrowserSplitRight', 'New browser tab in right split'),
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
  'tab.selectByIndex': () => translate('keybindings.title.eca3c9fdd7', 'Select tab 1–9'),
  'tab.openQuickCommandsMenu': () =>
    translate('keybindings.title.tabOpenQuickCommandsMenu', 'Toggle Quick Commands menu'),
  'browser.find': () => translate('keybindings.title.fbf2216baa', 'Find in browser'),
  'browser.back': () => translate('keybindings.title.0fe8d02935', 'Go back in browser'),
  'browser.forward': () => translate('keybindings.title.53ae577e44', 'Go forward in browser'),
  'browser.showHistory': () => translate('keybindings.title.92fad2c21f', 'Show browser history'),
  'browser.reload': () => translate('keybindings.title.67ce6cf5a0', 'Reload browser page'),
  'browser.hardReload': () => translate('keybindings.title.6bd12f3071', 'Hard reload browser page'),
  'browser.focusAddressBar': () =>
    translate('keybindings.title.2f2961bebf', 'Focus browser address bar'),
  'browser.grabElement': () => translate('keybindings.title.23350d5072', 'Grab page element'),
  'browser.annotateElement': () =>
    translate('keybindings.title.69b2b72c98', 'Annotate page element'),
  'editor.find': () => translate('keybindings.title.editorFind', 'Find in editor'),
  'editor.replace': () => translate('keybindings.title.editorReplace', 'Replace in editor'),
  'editor.save': () => translate('keybindings.title.6a99c55b2d', 'Save file'),
  'editor.markdownPreview': () =>
    translate('keybindings.title.e25a3e5f9a', 'Show Markdown preview'),
  'editor.toggleWordWrap': () => translate('keybindings.title.2f207aa199', 'Toggle word wrap'),
  'editor.copyContext': () => translate('keybindings.title.258e7f75ec', 'Copy context'),
  'editor.previousChange': () => translate('keybindings.title.324e886c0f', 'Go to previous change'),
  'editor.nextChange': () => translate('keybindings.title.7055c70bdb', 'Go to next change'),
  'editor.addReviewNote': () => translate('keybindings.title.9cb1023d40', 'Add review note'),
  'editor.pdfBack': () => translate('keybindings.title.editorPdfBack', 'Go back in PDF'),
  'editor.pdfForward': () => translate('keybindings.title.editorPdfForward', 'Go forward in PDF'),
  'sourceControl.sendReviewNotes': () =>
    translate('keybindings.title.e9da9f872a', 'Send review notes to agent'),
  'fileExplorer.undo': () => translate('keybindings.title.fileExplorerUndo', 'Undo file operation'),
  'fileExplorer.redo': () => translate('keybindings.title.fileExplorerRedo', 'Redo file operation'),
  'fileExplorer.copyPath': () =>
    translate('keybindings.title.fileExplorerCopyPath', 'Copy file path'),
  'fileExplorer.copyRelativePath': () =>
    translate('keybindings.title.fileExplorerCopyRelativePath', 'Copy relative file path'),
  'fileExplorer.delete': () => translate('keybindings.title.fileExplorerDelete', 'Delete file'),
  'settings.search': () => translate('keybindings.title.3acf4e9eb1', 'Search settings'),
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
  'terminal.setTitle': () => translate('keybindings.title.128cce6e6d', 'Set title…'),
  'chat.find': () => translate('keybindings.title.chatFind', 'Find in chat'),
  'terminal.toggleNativeChat': () =>
    translate('keybindings.title.terminalToggleNativeChat', 'Switch between Chat UI and terminal'),
  'sidebar.childWorkspaces.toggle': () =>
    translate('keybindings.title.8788e3be3a', 'Toggle child workspaces'),
  'terminal.clearPaneTitle': () => translate('keybindings.title.d286d1ab85', 'Clear pane title'),
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
  'Tab Navigation': () => translate('keybindings.group.45347db2a3', 'Tab navigation'),
  'Quick Commands': () => translate('keybindings.group.aab2837fa5', 'Quick commands'),
  Browser: () => translate('keybindings.group.browser', 'Browser'),
  Editors: () => translate('keybindings.group.editors', 'Editors'),
  'File Explorer': () => translate('keybindings.group.fileExplorer', 'File Explorer'),
  Settings: () => translate('keybindings.group.settings', 'Settings'),
  'Terminal Panes': () => translate('keybindings.group.3492a954c8', 'Terminal panes'),
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
