import type { GitLabProjectRef } from './gitlab-types'
import type { GitHubRepositoryIdentity } from './github/pull-request-types'

export type HostedReviewSubmissionAction = 'comment' | 'approve' | 'request-changes'

export type HostedReviewSubmissionComment = {
  body: string
  path: string
  oldPath?: string
  line: number
  startLine?: number
}

type HostedReviewSubmissionBase = {
  number: number
  expectedHead: string
  summary: string
  comments: HostedReviewSubmissionComment[]
}

export type HostedReviewSubmissionInput =
  | (HostedReviewSubmissionBase & {
      provider: 'github'
      action: HostedReviewSubmissionAction
      repository: GitHubRepositoryIdentity
    })
  | (HostedReviewSubmissionBase & {
      provider: 'gitlab'
      action: 'comment'
      projectRef: GitLabProjectRef
      baseSha: string
      startSha: string
    })

export type HostedReviewSubmissionResult =
  | {
      ok: true
      action: HostedReviewSubmissionAction
      submittedComments: number
    }
  | {
      ok: false
      code: 'invalid_target' | 'partial' | 'provider_error' | 'unsupported_action'
      submittedComments: number
      error: string
    }
