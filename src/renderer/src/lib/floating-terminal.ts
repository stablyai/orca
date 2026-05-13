// Why: a stable synthetic worktree id lets the floating terminal reuse the normal
// tab/store/TerminalPane lifecycle without attaching it to any repo worktree.
export const FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'

export const TOGGLE_FLOATING_TERMINAL_EVENT = 'orca-toggle-floating-terminal'
