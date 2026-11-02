import { resolveTerminalTeardownOwner } from '@/store/terminals/terminal-teardown-owner'
import type { WorktreeRuntimeOwner } from './worktree-runtime-owner'

export type AgentHibernationRuntimeOwner =
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'non-runtime' }
  // Why: hibernation must fail closed; no host can be asked for liveness or told to stop.
  | { kind: 'unresolved' }

/** `ptyIds` are the worktree's bound PTYs; they only decide the owner when two hosts publish it. */
export function toAgentHibernationRuntimeOwner(
  worktreeOwner: WorktreeRuntimeOwner,
  ptyIds: readonly string[]
): AgentHibernationRuntimeOwner {
  if (worktreeOwner.kind !== 'ambiguous') {
    return worktreeOwner
  }
  // Why: two hosts publish this worktree, so only each PTY's own `remote:<env>@@` id names its host.
  const teardownOwner = resolveTerminalTeardownOwner(worktreeOwner, ptyIds)
  if (teardownOwner.kind === 'refused') {
    return { kind: 'unresolved' }
  }
  const environmentId = teardownOwner.runtimeEnvironmentId
  return environmentId ? { kind: 'runtime', environmentId } : { kind: 'non-runtime' }
}
