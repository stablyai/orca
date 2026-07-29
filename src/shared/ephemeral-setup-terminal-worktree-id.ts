// Inline setup/onboarding terminals have no backing worktree. Branding their
// per-panel id lets the terminal RPC layer scope them to the floating terminal,
// instead of leaking an unresolvable selector to a remote runtime (#6789).
export const EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX = 'ephemeral-setup-terminal:'

/**
 * Brand a per-panel setup-terminal id so the terminal RPC layer routes it to the
 * floating-terminal scope on a runtime. Idempotent for already-branded ids.
 */
export function brandEphemeralSetupTerminalWorktreeId(panelId: string): string {
  return isEphemeralSetupTerminalWorktreeId(panelId)
    ? panelId
    : `${EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX}${panelId}`
}

/** Whether `worktreeId` is a branded ephemeral setup-terminal id. */
export function isEphemeralSetupTerminalWorktreeId(worktreeId: string): boolean {
  return worktreeId.startsWith(EPHEMERAL_SETUP_TERMINAL_WORKTREE_ID_PREFIX)
}
