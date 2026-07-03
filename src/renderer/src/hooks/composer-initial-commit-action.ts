import type { CreateInitialCommitResult } from '../../../shared/types'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'

export type ComposerInitialCommitActionDeps = {
  sourceRepoId: string
  createInitialCommit: () => Promise<CreateInitialCommitResult>
  getCurrentRepoId: () => string | null
  isSubmitInFlight: () => boolean
  isCancelled?: () => boolean
  setPending: (pending: boolean) => void
  setCreateError: (error: WorkspaceCreateErrorDisplay | null) => void
  setBaseBranch: (baseRef: string) => void
  /** Re-invokes the composer submit with the explicit base branch. */
  resubmit: (baseRef: string) => Promise<void>
}

/**
 * Runs the "Create initial commit" recovery action from the workspace-create
 * error box. On success, creation resumes by re-submitting with the returned
 * `baseRef` as the explicit base - re-probing the default would miss custom
 * default-branch names (trunk/develop) and reproduce the original error.
 */
export async function runComposerInitialCommitAction(
  deps: ComposerInitialCommitActionDeps
): Promise<void> {
  if (deps.isCancelled?.()) {
    return
  }
  deps.setPending(true)
  try {
    let result: CreateInitialCommitResult
    try {
      result = await deps.createInitialCommit()
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // Why: a late result from repo A must not render under a newly selected
    // repo B - the repo-switch guard applies to failures, not just successes.
    if (deps.isCancelled?.() || deps.getCurrentRepoId() !== deps.sourceRepoId) {
      return
    }
    if (!result.ok) {
      deps.setCreateError({ title: 'Could not create initial commit', message: result.error })
      return
    }
    if (
      deps.isCancelled?.() ||
      deps.getCurrentRepoId() !== deps.sourceRepoId ||
      deps.isSubmitInFlight()
    ) {
      return
    }
    deps.setCreateError(null)
    // Why: also fill the Create From slot so the UI reflects the base the
    // resumed submit is using; the override below is what the retry reads,
    // since React state set here is not visible to the in-flight closure.
    deps.setBaseBranch(result.baseRef)
    await deps.resubmit(result.baseRef)
  } finally {
    if (!deps.isCancelled?.()) {
      deps.setPending(false)
    }
  }
}
