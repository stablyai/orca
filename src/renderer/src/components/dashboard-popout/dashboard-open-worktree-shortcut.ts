import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'

/** Mirrors the dialog's "Open worktree" button as a board-scoped shortcut. */
export const DASHBOARD_OPEN_WORKTREE_ACTION_ID = 'dashboard.openWorktree' as const

type DashboardOpenWorktreeShortcutOptions = {
  platform: NodeJS.Platform
  /** Live user overrides. The pop-out window has no store, so it passes none. */
  keybindings?: KeybindingOverrides
  terminalShortcutPolicy?: TerminalShortcutPolicy
}

/**
 * Whether a key event should fire the agent dialog's "Open worktree" action.
 *
 * Why a renderer keydown listener instead of the main-process window-shortcut
 * allowlist: the chord is dialog-scoped. Orca must claim it only while an agent
 * terminal dialog is actually open, and the main process cannot know that — a
 * `before-input-event` rule would swallow the chord from the terminal everywhere.
 */
export function dashboardOpenWorktreeShortcutMatchesKeydown(
  event: KeyboardEvent,
  options: DashboardOpenWorktreeShortcutOptions
): boolean {
  if (event.repeat || event.isComposing) {
    return false
  }
  const input: KeybindingInput = {
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey
  }
  // Mirrors getKeybindingContext: the dialog's preview keeps xterm's helper
  // textarea focused, so the chord has to stay active in the terminal context.
  const context =
    event.target instanceof HTMLElement && event.target.classList.contains('xterm-helper-textarea')
      ? 'terminal'
      : 'app'
  return keybindingMatchesAction(
    DASHBOARD_OPEN_WORKTREE_ACTION_ID,
    input,
    options.platform,
    options.keybindings,
    { context, terminalShortcutPolicy: options.terminalShortcutPolicy }
  )
}
