import type { PausedLocalPathAdd } from '../dialog/add-repo-local-path-batch'
import type { NestedProjectReporter } from './useAddRepoNestedReviewState'

/** Reports the added projects once ready resolves, and null if it throws, so the wait always settles. */
export async function reportAfterGitRepoReady(
  reportProject: NestedProjectReporter | null,
  ready: () => Promise<unknown>,
  added: PausedLocalPathAdd
): Promise<void> {
  let settled = false
  try {
    await ready()
    settled = true
  } finally {
    reportProject?.(settled ? added : null)
  }
}
