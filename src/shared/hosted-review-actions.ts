import type { HostedReviewProvider } from './hosted-review'

/**
 * Generic hosted-review actions a forge provider may expose beyond
 * lookup/creation. Plugin forge providers implement these in the main process;
 * built-in providers keep their CLI/REST-specific paths.
 */

export type HostedReviewActionContext = {
  repoPath: string
  connectionId?: string | null
  provider: HostedReviewProvider
  number: number
}

export type MergeHostedReviewInput = HostedReviewActionContext & {
  method?: 'merge' | 'squash' | 'rebase'
  deleteBranch?: boolean
}

export type MergeHostedReviewResult =
  | { ok: true }
  | { ok: false; code: 'auth_required' | 'conflict' | 'unknown'; error: string }

export type CommentHostedReviewInput = HostedReviewActionContext & {
  body: string
  /** Optional file path for an inline comment. */
  path?: string
  /** Optional line number for an inline comment. */
  line?: number
}

export type CommentHostedReviewResult =
  | { ok: true; commentId?: string }
  | { ok: false; code: 'auth_required' | 'unknown'; error: string }

export type ApproveHostedReviewInput = HostedReviewActionContext

export type ApproveHostedReviewResult =
  | { ok: true }
  | { ok: false; code: 'auth_required' | 'unknown'; error: string }

export type ListHostedReviewCommentsInput = HostedReviewActionContext

export type ListHostedReviewCommentsResult =
  | {
      ok: true
      comments: {
        id: string
        body: string
        author: string
        createdAt?: string
        path?: string
        line?: number
      }[]
    }
  | { ok: false; code: 'auth_required' | 'unknown'; error: string }

export type HostedReviewIssueState = 'open' | 'closed' | 'all'

export type ListHostedReviewIssuesInput = {
  repoPath: string
  connectionId?: string | null
  provider: HostedReviewProvider
  state?: HostedReviewIssueState
  limit?: number
}

export type HostedReviewIssueSummary = {
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  url?: string
  updatedAt?: string
}

export type ListHostedReviewIssuesResult =
  | { ok: true; issues: HostedReviewIssueSummary[] }
  | { ok: false; code: 'auth_required' | 'unknown'; error: string }

/**
 * Capability descriptors surfaced to the renderer so UI can enable
 * merge/comment/approve controls only when the active provider supports them.
 */
export type HostedReviewActionCapabilities = {
  canMerge: boolean
  canComment: boolean
  canApprove: boolean
  canListIssues: boolean
}
