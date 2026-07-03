import { useAppStore } from '@/store'
import { createRuntimeRepoInitialCommit } from '@/runtime/runtime-repo-client'
import type { CreateInitialCommitResult } from '../../../shared/types'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'

/** Recover an unborn repo's failed background create: mint an initial commit,
 *  patch the pending request's base branch to the new ref, then retry. */
export async function createInitialCommitAndRetryWorktreeCreation(
  creationId: string
): Promise<void> {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (
    !entry ||
    entry.status !== 'error' ||
    entry.errorAction !== 'create-initial-commit' ||
    entry.initialCommitPending
  ) {
    return
  }

  store.updatePendingWorktreeCreation(creationId, { initialCommitPending: true })

  let result: CreateInitialCommitResult
  try {
    result = await createRuntimeRepoInitialCommit(store.settings, entry.request.repoId)
  } catch (error) {
    result = { ok: false as const, error: error instanceof Error ? error.message : String(error) }
  }

  // Why: the user may dismiss the failed create while the runtime is creating
  // the commit; a late result must not resurrect a panel they already removed.
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return
  }

  if (!result.ok) {
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      initialCommitPending: false,
      error: result.error
    })
    return
  }

  const latestEntry = useAppStore.getState().pendingWorktreeCreations[creationId]
  if (!latestEntry) {
    return
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    request: { ...latestEntry.request, baseBranch: result.baseRef },
    initialCommitPending: false,
    errorAction: undefined
  })
  retryBackgroundWorktreeCreation(creationId)
}
