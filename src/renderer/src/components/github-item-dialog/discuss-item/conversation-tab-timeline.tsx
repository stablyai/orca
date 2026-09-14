import React from 'react'
import { CheckCircle2, CircleDot, Link2, MoveRight, UserMinus, UserPlus } from 'lucide-react'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type {
  GitHubIssueTimelineItem,
  GitHubIssueTimelineTarget
} from '../../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'
import {
  getTimelineStateReasonLabel,
  getTimelineTargetLabel,
  type IssueConversationEntry
} from './issue-conversation-entries'
import {
  renderCommentCard,
  type ConversationCommentCardContext
} from './conversation-tab-comment-card'

export function renderTimelineTarget(
  target: GitHubIssueTimelineTarget | undefined
): React.ReactNode {
  if (!target) {
    return null
  }
  return (
    <button
      key={target.url}
      type="button"
      className="min-w-0 truncate font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground"
      title={getTimelineTargetLabel(target)}
      onClick={() => window.api.shell.openUrl(target.url)}
    >
      {getTimelineTargetLabel(target)}
    </button>
  )
}

export function renderTimelineActivityMessage(activity: GitHubIssueTimelineItem): React.ReactNode {
  const assignee =
    activity.assignee ?? translate('auto.components.GitHubItemDialog.timeline.someone', 'someone')
  if (activity.event === 'assigned') {
    return (
      <>
        {translate('auto.components.GitHubItemDialog.timeline.assigned', 'assigned')}{' '}
        <span className="font-medium text-foreground">{assignee}</span>
      </>
    )
  }
  if (activity.event === 'unassigned') {
    return (
      <>
        {translate('auto.components.GitHubItemDialog.timeline.unassigned', 'unassigned')}{' '}
        <span className="font-medium text-foreground">{assignee}</span>
      </>
    )
  }
  if (activity.event === 'mentioned' || activity.event === 'cross-referenced') {
    return (
      <>
        {translate('auto.components.GitHubItemDialog.timeline.mentioned', 'mentioned this')}
        {activity.source ? (
          <>
            {' '}
            {translate('auto.components.GitHubItemDialog.timeline.in', 'in')}{' '}
            {renderTimelineTarget(activity.source)}
          </>
        ) : null}
      </>
    )
  }
  if (activity.event === 'closed') {
    const stateReason = getTimelineStateReasonLabel(activity.stateReason)
    return (
      <>
        {translate('auto.components.GitHubItemDialog.timeline.closed', 'closed this')}
        {stateReason ? ` ${stateReason}` : ''}
        {activity.closer ? (
          <>
            {' '}
            {translate('auto.components.GitHubItemDialog.timeline.in', 'in')}{' '}
            {renderTimelineTarget(activity.closer)}
          </>
        ) : null}
      </>
    )
  }
  if (activity.event === 'reopened') {
    return translate('auto.components.GitHubItemDialog.timeline.reopened', 'reopened this')
  }
  const hasFrom = Boolean(activity.previousColumnName)
  const hasTo = Boolean(activity.columnName)
  return (
    <>
      {translate('auto.components.GitHubItemDialog.timeline.moved', 'moved this')}
      {hasFrom ? (
        <>
          {' '}
          {translate('auto.components.GitHubItemDialog.timeline.from', 'from')}{' '}
          <span className="font-medium text-foreground">{activity.previousColumnName}</span>
        </>
      ) : null}
      {hasTo ? (
        <>
          {' '}
          {translate('auto.components.GitHubItemDialog.timeline.to', 'to')}{' '}
          <span className="font-medium text-foreground">{activity.columnName}</span>
        </>
      ) : null}
      {activity.projectName ? (
        <>
          {' '}
          {translate('auto.components.GitHubItemDialog.timeline.in', 'in')}{' '}
          <span className="font-medium text-foreground">{activity.projectName}</span>
        </>
      ) : null}
    </>
  )
}

export function renderTimelineActivity(activity: GitHubIssueTimelineItem): React.JSX.Element {
  const Icon =
    activity.event === 'assigned'
      ? UserPlus
      : activity.event === 'unassigned'
        ? UserMinus
        : activity.event === 'closed'
          ? CheckCircle2
          : activity.event === 'reopened'
            ? CircleDot
            : activity.event === 'moved_columns_in_project'
              ? MoveRight
              : Link2
  return (
    <div
      key={`activity-${activity.id}`}
      className="flex min-w-0 items-start gap-3 rounded-md px-1 py-1.5 text-[13px] text-muted-foreground"
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/30 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      {activity.actorAvatarUrl ? (
        <img src={activity.actorAvatarUrl} alt="" className="mt-1 size-5 shrink-0 rounded-full" />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="font-medium text-foreground">{activity.actor}</span>
          <span className="contents">{renderTimelineActivityMessage(activity)}</span>
          <span className="text-[12px] text-muted-foreground">
            {formatRelativeTime(activity.createdAt)}
          </span>
        </div>
      </div>
    </div>
  )
}

export function renderIssueConversationEntry(
  entry: IssueConversationEntry,
  ctx: ConversationCommentCardContext
): React.JSX.Element {
  return entry.kind === 'comment'
    ? renderCommentCard(entry.comment, false, ctx)
    : renderTimelineActivity(entry.activity)
}

export function ConversationTabTimelineActivity({
  activity
}: {
  activity: GitHubIssueTimelineItem
}): React.JSX.Element {
  return renderTimelineActivity(activity)
}
