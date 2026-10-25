import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'

export type AbortConflictOperation = Extract<GitConflictOperation, 'merge' | 'rebase'>

// Pin the starting host because operations can outlive workspace focus.
export type SourceControlOperationTarget = Omit<RuntimeGitContext, 'target'> & {
  /** The repo owner's transport; `null` when no repo row names one, which refuses the call. */
  target: RuntimeClientTarget | null
  worktreeId: string
  pushTarget?: GitPushTarget
}

/** The git-client context for an operation; an unresolved owner throws the refusal. */
export function operationGitContext(
  operation: SourceControlOperationTarget,
  prefs?: RuntimeGitContext['prefs']
): RuntimeGitContext {
  return { ...operation, target: requireGitOwnerTarget(operation.target), prefs }
}
