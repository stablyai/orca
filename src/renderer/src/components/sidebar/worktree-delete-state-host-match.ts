import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeDeleteState } from '../../store/slices/worktree-helpers'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

export function getDeleteStateForWorktreeHost(
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  states: Readonly<Record<string, WorktreeDeleteState | undefined>>
): WorktreeDeleteState | undefined {
  const qualifiedState = worktree.hostId ? states[getWorktreeHostIdentity(worktree)] : undefined
  if (qualifiedState) {
    return qualifiedState
  }
  const legacyState = states[worktree.id]
  return legacyState?.executionHostId &&
    worktree.hostId &&
    legacyState.executionHostId !== worktree.hostId
    ? undefined
    : legacyState
}
