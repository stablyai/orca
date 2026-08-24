import { translate } from '@/i18n/i18n'

export function reviewThreadCommentCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.diff.comments.ReviewThreadCard.commentCount_one',
        '{{count}} comment',
        {
          count
        }
      )
    : translate(
        'auto.components.diff.comments.ReviewThreadCard.commentCount_other',
        '{{count}} comments',
        { count }
      )
}

export function reviewThreadExpandResolvedLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.diff.comments.ReviewThreadCard.expandResolved_one',
        'Resolved conversation, {{count}} comment — expand',
        { count }
      )
    : translate(
        'auto.components.diff.comments.ReviewThreadCard.expandResolved_other',
        'Resolved conversation, {{count}} comments — expand',
        { count }
      )
}

export function outdatedThreadsCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.diff.comments.ReviewThreadCard.outdatedThreads_one',
        '{{count}} outdated conversation',
        { count }
      )
    : translate(
        'auto.components.diff.comments.ReviewThreadCard.outdatedThreads_other',
        '{{count}} outdated conversations',
        { count }
      )
}

export function reviewThreadBadgeTitle(count: number): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.reviewThreadBadge_one',
        '{{count}} pull request conversation',
        { count }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.reviewThreadBadge_other',
        '{{count}} pull request conversations',
        { count }
      )
}
