import type { PRCheckDetail } from '../../../github/checks/check-types'
import type { PRComment } from '../../../github/comments/comment-types'
import type {
  AzureDevOpsPrCheck,
  AzureDevOpsPrThread
} from '../../../azure-devops/azure-devops-pr-review-types'

type CheckState = Pick<PRCheckDetail, 'status' | 'conclusion'>

// Policy evaluations: queued, running, approved, rejected, notApplicable, broken.
// Statuses: notSet, pending, succeeded, failed, error, notApplicable.
const STATES: Record<string, CheckState> = {
  queued: { status: 'queued', conclusion: null },
  notset: { status: 'queued', conclusion: null },
  running: { status: 'in_progress', conclusion: null },
  pending: { status: 'in_progress', conclusion: null },
  approved: { status: 'completed', conclusion: 'success' },
  succeeded: { status: 'completed', conclusion: 'success' },
  rejected: { status: 'completed', conclusion: 'failure' },
  failed: { status: 'completed', conclusion: 'failure' },
  error: { status: 'completed', conclusion: 'failure' },
  broken: { status: 'completed', conclusion: 'failure' },
  notapplicable: { status: 'completed', conclusion: 'skipped' }
}

const RESOLVED_THREAD_STATUSES = new Set(['fixed', 'closed', 'wontfix', 'bydesign'])

export function azureDevOpsChecksToPRChecks(
  checks: readonly AzureDevOpsPrCheck[]
): PRCheckDetail[] {
  return checks.map((check) => ({
    name: check.name,
    ...(STATES[check.status.toLowerCase()] ?? { status: 'completed', conclusion: 'neutral' }),
    url: check.url,
    ...(check.isStale && check.builtCommit ? { notLatestCommitSha: check.builtCommit } : {})
  }))
}

/** One row per comment, threads kept together by id, oldest first as the Checks list reads them. */
export function azureDevOpsThreadsToPRComments(
  threads: readonly AzureDevOpsPrThread[]
): PRComment[] {
  return threads
    .flatMap((thread) =>
      thread.comments.map((comment): PRComment => ({
        // Thread-scoped comment ids repeat across threads; keep row ids unique.
        id: thread.id * 1000 + comment.id,
        author: comment.author ?? '',
        authorAvatarUrl: '',
        body: comment.content,
        createdAt: comment.publishedDate ?? '',
        url: '',
        threadId: String(thread.id),
        isResolved:
          thread.status !== null && RESOLVED_THREAD_STATUSES.has(thread.status.toLowerCase()),
        ...(thread.filePath ? { path: thread.filePath.replace(/^\//, '') } : {}),
        ...(thread.line ? { line: thread.line } : {})
      }))
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}
