/* eslint-disable max-lines -- Why: this ordered registry is the audit surface
for configurable shortcuts and conflict precedence. */
import type {
  KeybindingActionId,
  KeybindingCatalogEntry,
  ShortcutSurface
} from './keybinding-types'

export const keybindingCatalog: KeybindingCatalogEntry[] = [
  {
    id: 'terminal.copySelection',
    title: 'Copy terminal selection',
    surfaces: ['terminal', 'terminalClipboardBypass'],
    defaults: {
      macos: ['cmd+shift+c'],
      linux: ['ctrl+shift+c'],
      windows: ['ctrl+shift+c']
    },
    command: { type: 'terminalCopySelection' }
  },
  {
    id: 'terminal.copySelectionIfSelected',
    title: 'Copy terminal selection if selected',
    surfaces: ['terminalClipboardBypass'],
    defaults: {
      macos: ['cmd+c'],
      linux: ['ctrl+c'],
      windows: ['ctrl+c']
    },
    command: { type: 'terminalCopySelectionIfSelected' }
  },
  {
    id: 'terminal.paste',
    title: 'Paste into terminal',
    surfaces: ['terminal', 'terminalClipboardBypass'],
    defaults: {
      macos: ['cmd+v'],
      linux: ['ctrl+v', 'ctrl+shift+v', 'shift+insert'],
      windows: ['ctrl+v', 'ctrl+shift+v', 'shift+insert']
    },
    command: { type: 'terminalPaste' }
  },
  {
    id: 'terminal.search.toggle',
    title: 'Toggle terminal search',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+f'],
      linux: ['ctrl+f'],
      windows: ['ctrl+f']
    },
    command: { type: 'terminalToggleSearch' }
  },
  {
    id: 'terminal.clear',
    title: 'Clear terminal pane',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+k'],
      linux: ['ctrl+k'],
      windows: ['ctrl+k']
    },
    command: { type: 'terminalClearActivePane' }
  },
  {
    id: 'terminal.focusPreviousPane',
    title: 'Focus previous terminal pane',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+['],
      linux: ['ctrl+['],
      windows: ['ctrl+[']
    },
    command: { type: 'terminalFocusPane', direction: 'previous' }
  },
  {
    id: 'terminal.focusNextPane',
    title: 'Focus next terminal pane',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+]'],
      linux: ['ctrl+]'],
      windows: ['ctrl+]']
    },
    command: { type: 'terminalFocusPane', direction: 'next' }
  },
  {
    id: 'terminal.expandActivePane.toggle',
    title: 'Toggle expanded terminal pane',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+shift+enter'],
      linux: ['ctrl+shift+enter'],
      windows: ['ctrl+shift+enter']
    },
    command: { type: 'terminalToggleExpandActivePane' }
  },
  {
    id: 'terminal.closeActivePane',
    title: 'Close active terminal pane',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+w'],
      linux: ['ctrl+w'],
      windows: ['ctrl+w']
    },
    command: { type: 'terminalCloseActivePane' }
  },
  {
    id: 'terminal.splitPane.vertical',
    title: 'Split terminal pane right',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+d'],
      linux: ['ctrl+shift+d'],
      windows: ['ctrl+shift+d']
    },
    command: { type: 'terminalSplitActivePane', direction: 'vertical' }
  },
  {
    id: 'terminal.splitPane.horizontal',
    title: 'Split terminal pane down',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+shift+d'],
      linux: ['alt+shift+d'],
      windows: ['alt+shift+d']
    },
    command: { type: 'terminalSplitActivePane', direction: 'horizontal' }
  },
  {
    id: 'terminal.input.wordLeft',
    title: 'Move terminal cursor one word left',
    surfaces: ['terminal'],
    defaults: {
      macos: ['alt+arrowleft'],
      linux: ['alt+arrowleft', 'ctrl+arrowleft'],
      windows: ['alt+arrowleft', 'ctrl+arrowleft']
    },
    command: { type: 'terminalSendInput', data: '\x1bb' }
  },
  {
    id: 'terminal.input.wordRight',
    title: 'Move terminal cursor one word right',
    surfaces: ['terminal'],
    defaults: {
      macos: ['alt+arrowright'],
      linux: ['alt+arrowright', 'ctrl+arrowright'],
      windows: ['alt+arrowright', 'ctrl+arrowright']
    },
    command: { type: 'terminalSendInput', data: '\x1bf' }
  },
  {
    id: 'terminal.input.lineStart',
    title: 'Move terminal cursor to line start',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+arrowleft']
    },
    command: { type: 'terminalSendInput', data: '\x01' }
  },
  {
    id: 'terminal.input.lineEnd',
    title: 'Move terminal cursor to line end',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+arrowright']
    },
    command: { type: 'terminalSendInput', data: '\x05' }
  },
  {
    id: 'terminal.input.shiftEnter',
    title: 'Send modified Enter to terminal',
    surfaces: ['terminal'],
    defaults: {
      macos: ['shift+enter'],
      linux: ['shift+enter'],
      windows: ['shift+enter']
    },
    command: { type: 'terminalSendInput', data: '\x1b[13;2u' }
  },
  {
    id: 'terminal.input.deleteWordLeft',
    title: 'Delete terminal word left',
    surfaces: ['terminal'],
    defaults: {
      macos: ['ctrl+backspace'],
      linux: ['ctrl+backspace'],
      windows: ['ctrl+backspace']
    },
    command: { type: 'terminalSendInput', data: '\x17' }
  },
  {
    id: 'terminal.input.deleteLineLeft',
    title: 'Delete terminal line left',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+backspace']
    },
    command: { type: 'terminalSendInput', data: '\x15' }
  },
  {
    id: 'terminal.input.deleteLineRight',
    title: 'Delete terminal line right',
    surfaces: ['terminal'],
    defaults: {
      macos: ['cmd+delete']
    },
    command: { type: 'terminalSendInput', data: '\x0b' }
  },
  {
    id: 'terminal.tab.new',
    title: 'Open new terminal tab',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+t'],
      linux: ['ctrl+t'],
      windows: ['ctrl+t']
    },
    command: { type: 'openNewTerminalTab' }
  },
  {
    id: 'terminal.tab.switch.next',
    title: 'Switch to next terminal tab',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['ctrl+pagedown'],
      linux: ['ctrl+pagedown'],
      windows: ['ctrl+pagedown']
    },
    command: { type: 'switchTerminalTab', direction: 'next' }
  },
  {
    id: 'terminal.tab.switch.previous',
    title: 'Switch to previous terminal tab',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['ctrl+pageup'],
      linux: ['ctrl+pageup'],
      windows: ['ctrl+pageup']
    },
    command: { type: 'switchTerminalTab', direction: 'previous' }
  },
  {
    id: 'browser.tab.new',
    title: 'Open new browser tab',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+shift+b'],
      linux: ['ctrl+shift+b'],
      windows: ['ctrl+shift+b']
    },
    command: { type: 'openNewBrowserTab' }
  },
  {
    id: 'browser.addressBar.focus',
    title: 'Focus browser address bar',
    surfaces: ['browserGuest'],
    defaults: {
      macos: ['cmd+l'],
      linux: ['ctrl+l'],
      windows: ['ctrl+l']
    },
    command: { type: 'focusBrowserAddressBar' }
  },
  {
    id: 'browser.find.open',
    title: 'Find in browser page',
    surfaces: ['browserGuest'],
    defaults: {
      macos: ['cmd+f'],
      linux: ['ctrl+f'],
      windows: ['ctrl+f']
    },
    command: { type: 'findInBrowserPage' }
  },
  {
    id: 'browser.page.reload',
    title: 'Reload browser page',
    surfaces: ['browserGuest'],
    defaults: {
      macos: ['cmd+r'],
      linux: ['ctrl+r'],
      windows: ['ctrl+r']
    },
    command: { type: 'reloadBrowserPage' }
  },
  {
    id: 'browser.page.hardReload',
    title: 'Hard reload browser page',
    surfaces: ['browserGuest'],
    defaults: {
      macos: ['cmd+shift+r'],
      linux: ['ctrl+shift+r'],
      windows: ['ctrl+shift+r']
    },
    command: { type: 'hardReloadBrowserPage' }
  },
  {
    id: 'browser.grabMode.toggle',
    title: 'Toggle browser grab mode',
    surfaces: ['browserGuest'],
    defaults: {
      macos: ['cmd+c'],
      linux: ['ctrl+c'],
      windows: ['ctrl+c']
    },
    command: { type: 'toggleBrowserGrabMode' }
  },
  {
    id: 'editor.file.save',
    title: 'Save active editor file',
    surfaces: ['mainWindow'],
    defaults: {
      macos: ['cmd+s'],
      linux: ['ctrl+s'],
      windows: ['ctrl+s']
    },
    command: { type: 'saveActiveEditorFile' }
  },
  {
    id: 'editor.file.newMarkdown',
    title: 'Open new markdown tab',
    surfaces: ['mainWindow'],
    defaults: {
      macos: ['cmd+shift+m'],
      linux: ['ctrl+shift+m'],
      windows: ['ctrl+shift+m']
    },
    command: { type: 'openNewMarkdownFile' }
  },
  {
    id: 'tab.closeActive',
    title: 'Close active tab',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+w'],
      linux: ['ctrl+w'],
      windows: ['ctrl+w']
    },
    command: { type: 'closeActiveTab' }
  },
  {
    id: 'tab.reopenClosed',
    title: 'Reopen closed tab',
    surfaces: ['mainWindow'],
    defaults: {
      macos: ['cmd+shift+t'],
      linux: ['ctrl+shift+t'],
      windows: ['ctrl+shift+t']
    },
    command: { type: 'reopenClosedTab' }
  },
  {
    id: 'tab.switch.next',
    title: 'Switch to next tab of active type',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+shift+]'],
      linux: ['ctrl+shift+]'],
      windows: ['ctrl+shift+]']
    },
    command: { type: 'switchTab', direction: 'next' }
  },
  {
    id: 'tab.switch.previous',
    title: 'Switch to previous tab of active type',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+shift+['],
      linux: ['ctrl+shift+['],
      windows: ['ctrl+shift+[']
    },
    command: { type: 'switchTab', direction: 'previous' }
  },
  {
    id: 'tab.switchAll.next',
    title: 'Switch to next tab across all types',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+alt+]'],
      linux: ['ctrl+alt+]'],
      windows: ['ctrl+alt+]']
    },
    command: { type: 'switchTabAcrossAllTypes', direction: 'next' }
  },
  {
    id: 'tab.switchAll.previous',
    title: 'Switch to previous tab across all types',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+alt+['],
      linux: ['ctrl+alt+['],
      windows: ['ctrl+alt+[']
    },
    command: { type: 'switchTabAcrossAllTypes', direction: 'previous' }
  },
  {
    id: 'window.zoomIn',
    title: 'Zoom in',
    surfaces: ['mainWindow', 'menu'],
    defaults: {
      macos: ['cmd+=', 'cmd+plus'],
      linux: ['ctrl+=', 'ctrl+plus'],
      windows: ['ctrl+=', 'ctrl+plus']
    },
    command: { type: 'zoom', direction: 'in' },
    allowRepeat: true
  },
  {
    id: 'window.zoomOut',
    title: 'Zoom out',
    surfaces: ['mainWindow', 'menu'],
    defaults: {
      macos: ['cmd+minus', 'cmd+_'],
      linux: ['ctrl+minus', 'ctrl+_'],
      windows: ['ctrl+minus', 'ctrl+_']
    },
    command: { type: 'zoom', direction: 'out' },
    allowRepeat: true
  },
  {
    id: 'window.zoomReset',
    title: 'Reset zoom',
    surfaces: ['mainWindow', 'menu'],
    defaults: {
      macos: ['cmd+0'],
      linux: ['ctrl+0'],
      windows: ['ctrl+0']
    },
    command: { type: 'zoom', direction: 'reset' }
  },
  {
    id: 'worktree.palette.toggle',
    title: 'Toggle worktree palette',
    surfaces: ['mainWindow', 'browserGuest', 'settings'],
    defaults: {
      macos: ['cmd+j'],
      linux: ['ctrl+shift+j'],
      windows: ['ctrl+shift+j']
    },
    command: { type: 'toggleWorktreePalette' }
  },
  {
    id: 'terminal.floating.toggle',
    title: 'Toggle floating terminal',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+alt+t'],
      linux: ['ctrl+alt+t'],
      windows: ['ctrl+alt+t']
    },
    command: { type: 'toggleFloatingTerminal' }
  },
  {
    id: 'sidebar.left.toggle',
    title: 'Toggle left sidebar',
    surfaces: ['mainWindow', 'menu'],
    defaults: {
      macos: ['cmd+b'],
      linux: ['ctrl+b'],
      windows: ['ctrl+b']
    },
    command: { type: 'toggleLeftSidebar' }
  },
  {
    id: 'sidebar.right.toggle',
    title: 'Toggle right sidebar',
    surfaces: ['mainWindow', 'menu'],
    defaults: {
      macos: ['cmd+l'],
      linux: ['ctrl+l'],
      windows: ['ctrl+l']
    },
    command: { type: 'toggleRightSidebar' }
  },
  {
    id: 'quickOpen.open',
    title: 'Open quick open',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+p'],
      linux: ['ctrl+p'],
      windows: ['ctrl+p']
    },
    command: { type: 'openQuickOpen' }
  },
  {
    id: 'workspace.new.open',
    title: 'Open new workspace composer',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+n', 'cmd+shift+n'],
      linux: ['ctrl+n', 'ctrl+shift+n'],
      windows: ['ctrl+n', 'ctrl+shift+n']
    },
    command: { type: 'openNewWorkspace' }
  },
  {
    id: 'worktree.history.back',
    title: 'Go back in worktree history',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+alt+arrowleft'],
      linux: ['ctrl+alt+arrowleft'],
      windows: ['ctrl+alt+arrowleft']
    },
    command: { type: 'worktreeHistoryNavigate', direction: 'back' }
  },
  {
    id: 'worktree.history.forward',
    title: 'Go forward in worktree history',
    surfaces: ['mainWindow', 'browserGuest'],
    defaults: {
      macos: ['cmd+alt+arrowright'],
      linux: ['ctrl+alt+arrowright'],
      windows: ['ctrl+alt+arrowright']
    },
    command: { type: 'worktreeHistoryNavigate', direction: 'forward' }
  },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((index) => ({
    id: `worktree.jump.${index}` as KeybindingActionId,
    title: `Jump to worktree ${index}`,
    surfaces: ['mainWindow', 'browserGuest'] as ShortcutSurface[],
    defaults: {
      macos: [`cmd+${index}`],
      linux: [`ctrl+${index}`],
      windows: [`ctrl+${index}`]
    },
    command: { type: 'jumpToWorktreeIndex' as const, index: index - 1 }
  }))
]
