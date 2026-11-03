import React from 'react'
import { CheckCircle2, CircleDot, Link2, MoveRight, UserMinus, UserPlus } from 'lucide-react'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import type {
  GitHubIssueTimelineItem,
  GitHubIssueTimelineTarget
} from '../../../../../shared/github/comment-types'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { getTimelineTargetLabel } from './issue-conversation-entries'
import { openAppHttpLink } from '@/lib/app-http-link-open'

export function renderTimelineTarget(
  target: GitHubIssueTimelineTarget | undefined
): React.JSX.Element | null {
  if (!target) {
    return null
  }
  return (
    <button
      key={target.url}
      type="button"
      className="min-w-0 truncate font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground"
      title={getTimelineTargetLabel(target)}
      onClick={(event) => openAppHttpLink(target.url, { event })}
    >
      {getTimelineTargetLabel(target)}
    </button>
  )
}

function getMovedTimelineTemplate(activity: GitHubIssueTimelineItem): string {
  const hasFrom = Boolean(activity.previousColumnName)
  const hasTo = Boolean(activity.columnName)
  const hasProject = Boolean(activity.projectName)
  if (hasFrom && hasTo) {
    return hasProject
      ? translate(
          'auto.components.GitHubItemDialog.timeline.movedFromToInProject',
          '<actor/> moved this from <from/> to <to/> in <project/>'
        )
      : translate(
          'auto.components.GitHubItemDialog.timeline.movedFromTo',
          '<actor/> moved this from <from/> to <to/>'
        )
  }
  if (hasTo) {
    return hasProject
      ? translate(
          'auto.components.GitHubItemDialog.timeline.movedToInProject',
          '<actor/> moved this to <to/> in <project/>'
        )
      : translate(
          'auto.components.GitHubItemDialog.timeline.movedTo',
          '<actor/> moved this to <to/>'
        )
  }
  if (hasFrom) {
    return hasProject
      ? translate(
          'auto.components.GitHubItemDialog.timeline.movedFromInProject',
          '<actor/> moved this from <from/> in <project/>'
        )
      : translate(
          'auto.components.GitHubItemDialog.timeline.movedFrom',
          '<actor/> moved this from <from/>'
        )
  }
  return hasProject
    ? translate(
        'auto.components.GitHubItemDialog.timeline.movedInProject',
        '<actor/> moved this in <project/>'
      )
    : translate('auto.components.GitHubItemDialog.timeline.movedThis', '<actor/> moved this')
}

function getClosedTimelineTemplate(activity: GitHubIssueTimelineItem): string {
  const hasCloser = Boolean(activity.closer)
  if (activity.stateReason === 'completed') {
    return hasCloser
      ? translate(
          'auto.components.GitHubItemDialog.timeline.closedCompletedIn',
          '<actor/> closed this as completed in <target/>'
        )
      : translate(
          'auto.components.GitHubItemDialog.timeline.closedCompleted',
          '<actor/> closed this as completed'
        )
  }
  if (activity.stateReason === 'not_planned') {
    return hasCloser
      ? translate(
          'auto.components.GitHubItemDialog.timeline.closedNotPlannedIn',
          '<actor/> closed this as not planned in <target/>'
        )
      : translate(
          'auto.components.GitHubItemDialog.timeline.closedNotPlanned',
          '<actor/> closed this as not planned'
        )
  }
  return hasCloser
    ? translate(
        'auto.components.GitHubItemDialog.timeline.closedIn',
        '<actor/> closed this in <target/>'
      )
    : translate('auto.components.GitHubItemDialog.timeline.closedThis', '<actor/> closed this')
}

function getTimelineActivityTemplate(activity: GitHubIssueTimelineItem): string {
  switch (activity.event) {
    case 'assigned':
      return translate(
        'auto.components.GitHubItemDialog.timeline.assignedUser',
        '<actor/> assigned <assignee/>'
      )
    case 'unassigned':
      return translate(
        'auto.components.GitHubItemDialog.timeline.unassignedUser',
        '<actor/> unassigned <assignee/>'
      )
    case 'mentioned':
    case 'cross-referenced':
      return activity.source
        ? translate(
            'auto.components.GitHubItemDialog.timeline.mentionedIn',
            '<actor/> mentioned this in <target/>'
          )
        : translate(
            'auto.components.GitHubItemDialog.timeline.mentionedThis',
            '<actor/> mentioned this'
          )
    case 'closed':
      return getClosedTimelineTemplate(activity)
    case 'reopened':
      return translate(
        'auto.components.GitHubItemDialog.timeline.reopenedThis',
        '<actor/> reopened this'
      )
    case 'moved_columns_in_project':
      return getMovedTimelineTemplate(activity)
  }
}

export function renderTimelineActivityMessage(activity: GitHubIssueTimelineItem): React.ReactNode {
  const emphasis = 'font-medium text-foreground'
  return (
    <Trans
      i18n={i18n}
      defaults={getTimelineActivityTemplate(activity)}
      components={{
        actor: <span className={emphasis}>{activity.actor}</span>,
        assignee: (
          <span className={emphasis}>
            {activity.assignee ??
              translate('auto.components.GitHubItemDialog.timeline.someone', 'someone')}
          </span>
        ),
        target: renderTimelineTarget(
          activity.event === 'closed' ? activity.closer : activity.source
        ) ?? <span />,
        from: <span className={emphasis}>{activity.previousColumnName}</span>,
        to: <span className={emphasis}>{activity.columnName}</span>,
        project: <span className={emphasis}>{activity.projectName}</span>
      }}
    />
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
          <span className="contents">{renderTimelineActivityMessage(activity)}</span>
          <span className="text-[12px] text-muted-foreground">
            {formatRelativeTime(activity.createdAt)}
          </span>
        </div>
      </div>
    </div>
  )
}

export function ConversationTabTimelineActivity({
  activity
}: {
  activity: GitHubIssueTimelineItem
}): React.JSX.Element {
  return renderTimelineActivity(activity)
}
