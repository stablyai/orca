import type { RuntimeGitContext } from '@/runtime/runtime-git-client'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'

export type AbortConflictOperation = Extract<GitConflictOperation, 'merge' | 'rebase'>

// Why: source-control operations outlive the focused worktree, so each one pins the host it started on.
export type SourceControlOperationTarget = RuntimeGitContext & {
  worktreeId: string
  pushTarget?: GitPushTarget
}
