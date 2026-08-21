import type { PRComment } from '../../../shared/types'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export type PRCommentScopeFilter = 'feedback' | 'all'

export const getPrCommentScopeFilters = createLocalizedCatalog(
  (): { value: PRCommentScopeFilter; label: string }[] => [
    { value: 'feedback', label: translate('auto.lib.pr.comment.scope.feedback', 'Feedback') },
    { value: 'all', label: translate('auto.lib.pr.comment.scope.all', 'All') }
  ]
)

export function isReviewFeedbackPRComment(comment: PRComment): boolean {
  return Boolean(comment.threadId)
}

export function getPRCommentScopeCounts(
  comments: PRComment[]
): Record<PRCommentScopeFilter, number> {
  const feedback = comments.filter(isReviewFeedbackPRComment).length
  return {
    feedback,
    all: comments.length
  }
}

export function filterPRCommentsByScope(
  comments: PRComment[],
  filter: PRCommentScopeFilter
): PRComment[] {
  if (filter === 'feedback') {
    return comments.filter(isReviewFeedbackPRComment)
  }
  return comments
}

export function getPRCommentScopeEmptyLabel(filter: PRCommentScopeFilter): string {
  switch (filter) {
    case 'feedback':
      return translate('auto.lib.pr.comment.scope.empty.feedback', 'No review feedback.')
    case 'all':
      return translate('auto.lib.pr.comment.scope.empty.all', 'No comments yet.')
  }
}
