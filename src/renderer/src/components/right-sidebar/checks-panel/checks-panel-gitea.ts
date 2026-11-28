import type { GiteaComment, GiteaPRCheck } from '../../../../../shared/gitea/gitea-types'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'
import type { PRComment } from '../../../../../shared/github/comments/comment-types'

function giteaCheckConclusion(state: GiteaPRCheck['state']): PRCheckDetail['conclusion'] {
  switch (state) {
    case 'success':
      return 'success'
    case 'failure':
    case 'error':
      return 'failure'
    case 'warning':
      return 'neutral'
    case 'pending':
      return 'pending'
  }
}

export function giteaPRChecksToPRChecks(checks: GiteaPRCheck[]): PRCheckDetail[] {
  return checks.map((check) => ({
    name: check.context,
    status: check.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: giteaCheckConclusion(check.state),
    url: check.targetUrl ?? null
  }))
}

// Gitea PR conversation comments are issue comments; they have no thread id /
// resolved flag, so the shared renderer hides resolve/edit affordances.
export function giteaIssueCommentsToPRComments(comments: GiteaComment[]): PRComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? '',
    authorAvatarUrl: comment.user?.avatarUrl ?? '',
    body: comment.body,
    createdAt: comment.createdAt,
    url: ''
  }))
}
