import type { ClassifiedError } from '../../../shared/types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'

export type GitLabProjectFetchResult = {
  repoId: string
  items: GitLabWorkItem[]
  error?: Pick<ClassifiedError, 'type' | 'message'>
}

const CLASSIFIED_ERROR_TYPES: ReadonlySet<ClassifiedError['type']> = new Set([
  'permission_denied',
  'not_found',
  'issues_disabled',
  'validation_error',
  'rate_limited',
  'network_error',
  'unknown'
])

export function toGitLabProjectFetchResult(
  repoId: string,
  result: {
    items: GitLabWorkItem[]
    error?: { type?: ClassifiedError['type']; message: string }
  }
): GitLabProjectFetchResult {
  if (!result.error) {
    return { repoId, items: result.items }
  }
  const type = result.error.type
  const normalizedType: ClassifiedError['type'] =
    type && CLASSIFIED_ERROR_TYPES.has(type) ? type : 'unknown'
  return {
    repoId,
    items: result.items,
    error: { type: normalizedType, message: result.error.message }
  }
}

export type GitLabMultiProjectAggregate = {
  items: GitLabWorkItem[]
  hardErrors: string[]
  skippedNotFoundCount: number
  failedCount: number
  successCount: number
  // Why: banner only when every project hard-failed and nothing rendered.
  bannerError: string | null
}

// Why: soft-skip not_found so one migrated peer cannot own the multi-project view (#13817).
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
