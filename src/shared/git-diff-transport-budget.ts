import type { GitDiffResult } from './types'
import { remoteRpcResultExceedsContentBudget } from './remote-rpc-content-budget'

export const GIT_DIFF_TOO_LARGE_CODE = 'diff_too_large'
const GIT_DIFF_CONTENT_FIELDS = ['originalContent', 'modifiedContent'] as const

/** Whether the complete diff result exceeds `maxBytes` once JSON-encoded. */
export function gitDiffExceedsTransportBudget(result: GitDiffResult, maxBytes: number): boolean {
  return remoteRpcResultExceedsContentBudget(result, maxBytes, GIT_DIFF_CONTENT_FIELDS)
}

/** `maxBytes === undefined` means uncapped: local and in-process callers keep full fidelity. */
export function assertGitDiffWithinTransportBudget<T extends GitDiffResult>(
  result: T,
  maxBytes: number | undefined
): T {
  if (maxBytes === undefined || !gitDiffExceedsTransportBudget(result, maxBytes)) {
    return result
  }
  throw Object.assign(new Error('This diff is too large to open over a remote connection.'), {
    code: GIT_DIFF_TOO_LARGE_CODE,
    data: { maxBytes }
  })
}
