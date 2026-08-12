import type { ClassifiedError } from '../../../shared/types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'

export type GitLabProjectFetchResult = {
  repoId: string
  items: GitLabWorkItem[]
  error?: Pick<ClassifiedError, 'type' | 'message'>
}

export function toGitLabProjectFetchResult(
  repoId: string,
  result: {
    items: GitLabWorkItem[]
    error?: { type?: ClassifiedError['type'] | string; message: string }
  }
): GitLabProjectFetchResult {
  if (!result.error) {
    return { repoId, items: result.items }
  }
  const type = result.error.type
  const normalizedType: ClassifiedError['type'] =
    type === 'permission_denied' ||
    type === 'not_found' ||
    type === 'issues_disabled' ||
    type === 'validation_error' ||
    type === 'rate_limited' ||
    type === 'network_error' ||
    type === 'unknown'
      ? type
      : 'unknown'
  return {
    repoId,
    items: result.items,
    error: { type: normalizedType, message: result.error.message }
  }
}

export type GitLabMultiProjectAggregate = {
  items: GitLabWorkItem[]
  /** Hard errors that should surface to the user (not soft not_found skips). */
  hardErrors: string[]
  /** Projects skipped because they are not a resolvable GitLab project. */
  skippedNotFoundCount: number
  /** Projects that returned a hard error. */
  failedCount: number
  /** Projects that produced items or a soft empty success. */
  successCount: number
  /**
   * Banner copy when every queried project hard-failed and nothing rendered.
   * Soft not_found-only selections yield null so the empty state can show.
   */
  bannerError: string | null
}

/**
 * Aggregate per-project GitLab list results for the Tasks "All projects" view.
 *
 * Why: a single non-GitLab/migrated project used to replace the whole multi-project
 * list with raw glab stderr (#13817). Soft not_found is expected in mixed
 * selections and must not own the banner; hard errors only banner when nothing
 * else rendered.
 */
export function aggregateGitLabMultiProjectResults(
  results: readonly GitLabProjectFetchResult[]
): GitLabMultiProjectAggregate {
  const items: GitLabWorkItem[] = []
  const hardErrors: string[] = []
  let skippedNotFoundCount = 0
  let failedCount = 0
  let successCount = 0

  for (const result of results) {
    for (const item of result.items) {
      items.push({ ...item, repoId: result.repoId })
    }
    const error = result.error
    if (!error) {
      successCount += 1
      continue
    }
    // Why: not_found means "this selection entry is not a GitLab project" —
    // expected after a migration or mixed picker selection, not a load failure.
    if (error.type === 'not_found') {
      skippedNotFoundCount += 1
      continue
    }
    failedCount += 1
    hardErrors.push(error.message)
  }

  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  const bannerError =
    hardErrors.length > 0 && items.length === 0 && successCount === 0
      ? (hardErrors[0] ?? null)
      : null

  return {
    items,
    hardErrors,
    skippedNotFoundCount,
    failedCount,
    successCount,
    bannerError
  }
}
