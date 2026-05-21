import { keybindingMatchesAction, type KeybindingOverrides } from './keybindings'

export type WindowShortcutInput = {
  type?: string
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

export type WindowShortcutAction =
  | { type: 'zoom'; direction: 'in' | 'out' | 'reset' }
  | { type: 'toggleWorktreePalette' }
  | { type: 'toggleFloatingTerminal' }
  | { type: 'toggleLeftSidebar' }
  | { type: 'toggleRightSidebar' }
  | { type: 'openQuickOpen' }
  | { type: 'openNewWorkspace' }
  | { type: 'openTasks' }
  | { type: 'switchRecentTab' }
  | { type: 'jumpToWorktreeIndex'; index: number }
  | { type: 'worktreeHistoryNavigate'; direction: 'back' | 'forward' }
  | { type: 'dictationKeyDown' }

function platformPrimaryModifier(
  input: Pick<WindowShortcutInput, 'meta' | 'control'>,
  platform: NodeJS.Platform
): boolean {
  return platform === 'darwin' ? Boolean(input.meta) : Boolean(input.control)
}

export function isWindowShortcutModifierChord(
  input: Pick<WindowShortcutInput, 'meta' | 'control' | 'alt'>,
  platform: NodeJS.Platform
): boolean {
  return platformPrimaryModifier(input, platform) && !input.alt
}

export function matchesRecentTabSwitcherChord(
  input: WindowShortcutInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  const control = Boolean(input.control ?? input.ctrlKey)
  const meta = Boolean(input.meta ?? input.metaKey)
  const alt = Boolean(input.alt ?? input.altKey)
  if (input.code !== 'Tab' || !control || meta || alt) {
    return false
  }
  // Why: the Ctrl+Tab switcher is a held-key interaction where Shift reverses
  // direction. Gate the whole family on the configurable unshifted binding.
  return keybindingMatchesAction(
    'tab.previousRecent',
    {
      key: input.key,
      code: input.code,
      alt,
      meta,
      control,
      shift: false,
      altKey: alt,
      metaKey: meta,
      ctrlKey: control,
      shiftKey: false
    },
    platform,
    keybindings
  )
}

export function resolveWindowShortcutAction(
  input: WindowShortcutInput,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): WindowShortcutAction | null {
  if (keybindingMatchesAction('worktree.history.back', input, platform, keybindings)) {
    return {
      type: 'worktreeHistoryNavigate',
      direction: 'back'
    }
  }

  if (keybindingMatchesAction('worktree.history.forward', input, platform, keybindings)) {
    return {
      type: 'worktreeHistoryNavigate',
      direction: 'forward'
    }
  }

  if (keybindingMatchesAction('floatingTerminal.toggle', input, platform, keybindings)) {
    return { type: 'toggleFloatingTerminal' }
  }

  if (keybindingMatchesAction('zoom.in', input, platform, keybindings)) {
    return { type: 'zoom', direction: 'in' }
  }

  if (keybindingMatchesAction('zoom.out', input, platform, keybindings)) {
    return { type: 'zoom', direction: 'out' }
  }

  if (keybindingMatchesAction('zoom.reset', input, platform, keybindings)) {
    return { type: 'zoom', direction: 'reset' }
  }

  if (keybindingMatchesAction('worktree.palette', input, platform, keybindings)) {
    return { type: 'toggleWorktreePalette' }
  }

  if (keybindingMatchesAction('sidebar.left.toggle', input, platform, keybindings)) {
    return { type: 'toggleLeftSidebar' }
  }

  if (keybindingMatchesAction('sidebar.right.toggle', input, platform, keybindings)) {
    return { type: 'toggleRightSidebar' }
  }

  if (keybindingMatchesAction('worktree.quickOpen', input, platform, keybindings)) {
    return { type: 'openQuickOpen' }
  }

  // Why: Cmd/Ctrl+N opens the new-workspace composer. Routed through the
  // main process so it reaches the renderer even when focus lives inside
  // a contentEditable surface (markdown rich editor) or a browser guest
  // webContents, both of which bypass the renderer's window-level keydown.
  // Shift is accepted for compatibility with the former Create-from shortcut;
  // the unified composer now exposes source switching inside the name field.
  if (keybindingMatchesAction('workspace.create', input, platform, keybindings)) {
    return { type: 'openNewWorkspace' }
  }

  if (keybindingMatchesAction('voice.dictation', input, platform, keybindings)) {
    return { type: 'dictationKeyDown' }
  }

  if (keybindingMatchesAction('view.tasks', input, platform, keybindings)) {
    return { type: 'openTasks' }
  }

  if (keybindingMatchesAction('tab.previousRecent', input, platform, keybindings)) {
    return { type: 'switchRecentTab' }
  }

  if (
    platformPrimaryModifier(input, platform) &&
    !input.alt &&
    !input.shift &&
    input.key &&
    input.key >= '1' &&
    input.key <= '9'
  ) {
    return { type: 'jumpToWorktreeIndex', index: parseInt(input.key, 10) - 1 }
  }

  // Why: this helper is the explicit allowlist for main-process interception.
  // Anything not listed here must keep flowing to the renderer/PTTY so readline
  // chords like Ctrl+R, Ctrl+U, and Ctrl+E are not accidentally stolen while
  // terminals own focus.
  return null
}
