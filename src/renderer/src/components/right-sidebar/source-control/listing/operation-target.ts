import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export type AbortConflictOperation = Extract<GitConflictOperation, 'merge' | 'rebase'>

// Pin the starting host because operations can outlive workspace focus.
export type SourceControlOperationTarget = Omit<RuntimeGitContext, 'target'> & {
  /** The repo owner's transport; `null` when no repo row names one, which refuses the call. */
  target: RuntimeClientTarget | null
  worktreeId: string
  /** The worktree copy `target` answers for; a same-path twin on another host shares the id. */
  ownerHostId?: ExecutionHostId | null
  pushTarget?: GitPushTarget
}

/** The git-client context for an operation; an unresolved owner throws the refusal. */
export function operationGitContext(
  operation: SourceControlOperationTarget,
  prefs?: RuntimeGitContext['prefs']
): RuntimeGitContext {
  // Why drop ownerHostId: it names the store copy to patch and is not part of the request.
  const { ownerHostId: _ownerHostId, ...request } = operation
  return { ...request, target: requireGitOwnerTarget(operation.target), prefs }
}
