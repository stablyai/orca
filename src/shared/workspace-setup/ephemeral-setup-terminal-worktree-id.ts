// Setup terminals have no worktree; brand panel IDs so RPC routes them through floating scope instead of unresolved remote selectors (#6789).
export const EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX = 'ephemeral-setup-terminal:'

/** Brand setup IDs idempotently for runtime floating-terminal routing. */
export function brandEphemeralSetupTerminalWorktreeId(panelId: string): string {
  return isEphemeralSetupTerminalWorktreeId(panelId)
    ? panelId
    : `${EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX}${panelId}`
}

export function isEphemeralSetupTerminalWorktreeId(worktreeId: string): boolean {
  return worktreeId.startsWith(EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX)
}
