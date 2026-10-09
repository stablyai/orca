import { floatingWorkspaceEnvironmentId } from '../../../shared/floating-workspace-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'

const RUNTIME_WORKTREE_ID_SELECTOR_PREFIX = 'id:'

/** Client-only floating host namespaces never cross the runtime boundary. */
export function toRuntimeWorktreeId(worktreeId: string): string {
  return floatingWorkspaceEnvironmentId(worktreeId) ? FLOATING_TERMINAL_WORKTREE_ID : worktreeId
}

export function toRuntimeWorktreeSelector(worktreeId: string): string {
  const trimmed = worktreeId.trim()
  if (!trimmed) {
    return trimmed
  }
  const id = trimmed.startsWith(RUNTIME_WORKTREE_ID_SELECTOR_PREFIX)
    ? trimmed.slice(RUNTIME_WORKTREE_ID_SELECTOR_PREFIX.length)
    : trimmed
  return `${RUNTIME_WORKTREE_ID_SELECTOR_PREFIX}${toRuntimeWorktreeId(id)}`
}

/**
 * Runtime selector for a terminal's worktree id. Ephemeral setup terminals have no
 * worktree on the runtime, so resolve them to the floating-terminal scope (home dir)
 * every runtime understands; other ids map to their own `id:` selector.
 */
export function toRuntimeTerminalWorktreeSelector(worktreeId: string): string {
  if (isEphemeralSetupTerminalWorktreeId(worktreeId.trim())) {
    return toRuntimeWorktreeSelector(FLOATING_TERMINAL_WORKTREE_ID)
  }
  return toRuntimeWorktreeSelector(worktreeId)
}
