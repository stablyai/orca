export type KeybindingActionId =
  | 'goToFile'
  | 'switchWorktree'
  | 'createWorktree'
  | 'toggleSidebar'
  | 'toggleRightSidebar'
  | 'moveUpWorktree'
  | 'moveDownWorktree'
  | 'toggleFileExplorer'
  | 'toggleSearch'
  | 'toggleSourceControl'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetSize'
  | 'forceReload'
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'focusNextPane'
  | 'focusPrevPane'
  | 'clearPane'
  | 'expandPane'
  | 'copySelection'
  | 'toggleSearch_terminal'
  | 'backwardKillWord'
  | 'backwardKillWordAlt'
  | 'shiftEnter'

export type KeybindingGroup = {
  title: string
  items: { id: KeybindingActionId; label: string; searchKeywords: string[] }[]
}

export const KEYBINDING_GROUPS: KeybindingGroup[] = [
  {
    title: 'Global',
    items: [
      { id: 'goToFile', label: 'Go to File', searchKeywords: ['shortcut', 'global', 'file'] },
      {
        id: 'switchWorktree',
        label: 'Switch worktree',
        searchKeywords: ['shortcut', 'global', 'worktree', 'switch', 'jump']
      },
      {
        id: 'createWorktree',
        label: 'Create worktree',
        searchKeywords: ['shortcut', 'global', 'worktree']
      },
      { id: 'toggleSidebar', label: 'Toggle Sidebar', searchKeywords: ['shortcut', 'sidebar'] },
      {
        id: 'toggleRightSidebar',
        label: 'Toggle Right Sidebar',
        searchKeywords: ['shortcut', 'sidebar', 'right']
      },
      {
        id: 'moveUpWorktree',
        label: 'Move up worktree',
        searchKeywords: ['shortcut', 'global', 'worktree', 'move']
      },
      {
        id: 'moveDownWorktree',
        label: 'Move down worktree',
        searchKeywords: ['shortcut', 'global', 'worktree', 'move']
      },
      {
        id: 'toggleFileExplorer',
        label: 'Toggle File Explorer',
        searchKeywords: ['shortcut', 'file explorer']
      },
      { id: 'toggleSearch', label: 'Toggle Search', searchKeywords: ['shortcut', 'search'] },
      {
        id: 'toggleSourceControl',
        label: 'Toggle Source Control',
        searchKeywords: ['shortcut', 'source control']
      },
      {
        id: 'zoomIn',
        label: 'Zoom In',
        searchKeywords: ['shortcut', 'zoom', 'in', 'scale']
      },
      {
        id: 'zoomOut',
        label: 'Zoom Out',
        searchKeywords: ['shortcut', 'zoom', 'out', 'scale']
      },
      {
        id: 'resetSize',
        label: 'Reset Size',
        searchKeywords: ['shortcut', 'zoom', 'reset', 'size', 'actual']
      },
      {
        id: 'forceReload',
        label: 'Force Reload',
        searchKeywords: ['shortcut', 'reload', 'refresh', 'force']
      }
    ]
  },
  {
    title: 'Terminal Tabs',
    items: [
      { id: 'newTab', label: 'New tab', searchKeywords: ['shortcut', 'tab'] },
      {
        id: 'closeTab',
        label: 'Close active tab / pane',
        searchKeywords: ['shortcut', 'close', 'tab', 'pane']
      },
      { id: 'nextTab', label: 'Next tab', searchKeywords: ['shortcut', 'tab', 'next'] },
      {
        id: 'prevTab',
        label: 'Previous tab',
        searchKeywords: ['shortcut', 'tab', 'previous']
      }
    ]
  },
  {
    title: 'Terminal Panes',
    items: [
      {
        id: 'splitRight',
        label: 'Split pane right',
        searchKeywords: ['shortcut', 'pane', 'split']
      },
      {
        id: 'splitDown',
        label: 'Split pane down',
        searchKeywords: ['shortcut', 'pane', 'split']
      },
      {
        id: 'closePane',
        label: 'Close pane (EOF)',
        searchKeywords: ['shortcut', 'pane', 'close', 'eof']
      },
      {
        id: 'focusNextPane',
        label: 'Focus next pane',
        searchKeywords: ['shortcut', 'pane', 'focus', 'next']
      },
      {
        id: 'focusPrevPane',
        label: 'Focus previous pane',
        searchKeywords: ['shortcut', 'pane', 'focus', 'previous']
      },
      {
        id: 'clearPane',
        label: 'Clear active pane',
        searchKeywords: ['shortcut', 'pane', 'clear']
      },
      {
        id: 'expandPane',
        label: 'Expand / collapse pane',
        searchKeywords: ['shortcut', 'pane', 'expand', 'collapse']
      }
    ]
  }
]

export function getDefaultKeybindings(isMac: boolean): Record<KeybindingActionId, string> {
  const mod = isMac ? 'Cmd' : 'Ctrl'
  return {
    goToFile: `${mod}+P`,
    switchWorktree: isMac ? `${mod}+J` : `${mod}+Shift+J`,
    createWorktree: `${mod}+N`,
    toggleSidebar: `${mod}+B`,
    toggleRightSidebar: `${mod}+L`,
    moveUpWorktree: `${mod}+Shift+Up`,
    moveDownWorktree: `${mod}+Shift+Down`,
    toggleFileExplorer: `${mod}+Shift+E`,
    toggleSearch: `${mod}+Shift+F`,
    toggleSourceControl: `${mod}+Shift+G`,
    zoomIn: isMac ? `${mod}++` : `${mod}+Shift++`,
    zoomOut: isMac ? `${mod}+-` : `${mod}+Shift+-`,
    resetSize: `${mod}+0`,
    forceReload: `${mod}+Shift+R`,
    newTab: `${mod}+T`,
    closeTab: `${mod}+W`,
    nextTab: `${mod}+Shift+]`,
    prevTab: `${mod}+Shift+[`,
    splitRight: `${mod}+D`,
    splitDown: `${mod}+Shift+D`,
    closePane: 'Ctrl+D',
    focusNextPane: `${mod}+]`,
    focusPrevPane: `${mod}+[`,
    clearPane: `${mod}+K`,
    expandPane: `${mod}+Shift+Enter`,
    copySelection: `${mod}+Shift+C`,
    toggleSearch_terminal: `${mod}+F`,
    backwardKillWord: 'Ctrl+Backspace',
    backwardKillWordAlt: 'Alt+Backspace',
    shiftEnter: 'Shift+Enter'
  }
}

export function parseKeyCombo(combo: string, isMac: boolean): string[] {
  return combo.split('+').map((part) => {
    if (isMac) {
      if (part === 'Cmd') {
        return '\u2318'
      }
      if (part === 'Ctrl') {
        return '\u2303'
      }
      if (part === 'Shift') {
        return '\u21E7'
      }
      if (part === 'Alt') {
        return '\u2325'
      }
      if (part === 'Enter') {
        return '\u21B5'
      }
      if (part === 'Up') {
        return '\u2191'
      }
      if (part === 'Down') {
        return '\u2193'
      }
      if (part === 'Backspace') {
        return '\u232B'
      }
    }
    return part
  })
}

export function resolveKeybinding(
  actionId: KeybindingActionId,
  customBindings: Record<string, string>,
  isMac: boolean
): string {
  return customBindings[actionId] ?? getDefaultKeybindings(isMac)[actionId]
}

export function keyEventToCombo(e: KeyboardEvent, isMac: boolean): string {
  const parts: string[] = []
  if (isMac) {
    if (e.metaKey) {
      parts.push('Cmd')
    }
    if (e.ctrlKey) {
      parts.push('Ctrl')
    }
  } else {
    if (e.ctrlKey) {
      parts.push('Ctrl')
    }
    if (e.metaKey) {
      parts.push('Meta')
    }
  }
  if (e.altKey) {
    parts.push('Alt')
  }
  if (e.shiftKey) {
    parts.push('Shift')
  }

  const key = e.key
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) {
    if (key === 'ArrowUp') {
      parts.push('Up')
    } else if (key === 'ArrowDown') {
      parts.push('Down')
    } else if (key === 'ArrowLeft') {
      parts.push('Left')
    } else if (key === 'ArrowRight') {
      parts.push('Right')
    } else if (key === ' ') {
      parts.push('Space')
    } else if (key.length === 1) {
      parts.push(key.toUpperCase())
    } else {
      parts.push(key)
    }
  }

  return parts.join('+')
}

export function matchesKeyCombo(e: KeyboardEvent, combo: string, isMac: boolean): boolean {
  const eventCombo = keyEventToCombo(e, isMac)
  return eventCombo === combo
}
