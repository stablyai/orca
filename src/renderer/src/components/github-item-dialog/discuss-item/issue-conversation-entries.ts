import type {
  GitHubIssueTimelineItem,
  GitHubIssueTimelineTarget,
  PRComment
} from '../../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'

export type IssueConversationEntry =
  | { kind: 'comment'; id: string; createdAt: string; comment: PRComment; index: number }
  | {
      kind: 'activity'
      id: string
      createdAt: string
      activity: GitHubIssueTimelineItem
      index: number
    }

export const EMPTY_GITHUB_ISSUE_TIMELINE_ITEMS: GitHubIssueTimelineItem[] = []

function getTimelineSortValue(createdAt: string): number {
  const value = new Date(createdAt).getTime()
  return Number.isFinite(value) ? value : 0
}

export function getIssueConversationEntries(
  comments: PRComment[],
  timelineItems: GitHubIssueTimelineItem[]
): IssueConversationEntry[] {
  return [
    ...comments.map((comment, index): IssueConversationEntry => ({
      kind: 'comment',
      id: `comment:${comment.id}`,
      createdAt: comment.createdAt,
      comment,
      index
    })),
    ...timelineItems.map((activity, index): IssueConversationEntry => ({
      kind: 'activity',
      id: `activity:${activity.id}`,
      createdAt: activity.createdAt,
      activity,
      index: comments.length + index
    }))
  ].sort((a, b) => {
    const diff = getTimelineSortValue(a.createdAt) - getTimelineSortValue(b.createdAt)
    return diff === 0 ? a.index - b.index : diff
  })
}

export function getTimelineTargetLabel(target: GitHubIssueTimelineTarget): string {
  const reference =
    target.type === 'pr'
      ? translate(
          'auto.components.GitHubItemDialog.timeline.pullRequestReference',
          'PR #{{number}}',
          { number: target.number }
        )
      : translate('auto.components.GitHubItemDialog.timeline.issueReference', 'issue #{{number}}', {
          number: target.number
        })
  return target.title ? `${reference} ${target.title}` : reference
}
