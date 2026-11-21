import { useEffect } from 'react'
import { readRuntimeGitRebaseAutoStash } from '@/runtime/source-control/git/runtime-git-rebase-client'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { requireGitOwnerTarget } from './worktree-git-owner-target'

/** Read rebase.autoStash only when a dirty tree would block Rebase, re-reading on each such transition. */
export function useRebaseAutoStashProbe({
  activeRepoTarget,
  activeWorktreeId,
  operationStore,
  shouldProbe,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  operationStore: SourceControlWorktreeOperationState['operationStore']
  shouldProbe: boolean
  worktreePath: string | null
}): void {
  const scope = useSourceControlScope()
  useEffect(() => {
    // An older host already said it cannot answer; the store is per host incarnation.
    if (
      !shouldProbe ||
      !activeWorktreeId ||
      !worktreePath ||
      operationStore.getState().rebaseAutoStash === 'unsupported'
    ) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const autoStash = await readRuntimeGitRebaseAutoStash({
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: sourceControlConnectionId(scope, activeWorktreeId)
        })
        if (!cancelled) {
          operationStore.setState({ rebaseAutoStash: autoStash })
        }
      } catch {
        // Unknown stays blocked, which matches Git's default refusal.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeRepoTarget, activeWorktreeId, operationStore, scope, shouldProbe, worktreePath])
}
