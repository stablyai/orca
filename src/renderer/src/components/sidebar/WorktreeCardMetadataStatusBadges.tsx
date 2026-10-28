import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getReviewChecksTone } from './worktree-review-helpers'
import { Badge } from '@/components/ui/badge'
import { CircleCheck, CircleDot, CircleX, Clock, GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PullRequestIcon, checksLabel } from './WorktreeCardHelpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { IssueInfo } from '../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

function MetadataStatusBadge({
  label,
  children,
  className
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-4 gap-1 rounded px-1.5 text-[9px] font-medium leading-none [&>svg]:size-2.5',
        className
      )}
    >
      {children}
      <span>{label}</span>
    </Badge>
  )
}

export function IssueStateBadge({ state }: { state: IssueInfo['state'] }): React.JSX.Element {
  if (state === 'closed') {
    return (
      <MetadataStatusBadge
        label={translate(
          'auto.components.sidebar.WorktreeCardMetadataStatusBadges.e888362def',
          'State: Closed'
        )}
        className="border-purple-500/25 bg-purple-500/5 text-purple-600 dark:text-purple-300"
      >
        <CircleCheck />
      </MetadataStatusBadge>
    )
  }

  return (
    <MetadataStatusBadge
      label={translate(
        'auto.components.sidebar.WorktreeCardMetadataStatusBadges.fe188062a1',
        'State: Open'
      )}
      className="border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300"
    >
      <CircleDot />
    </MetadataStatusBadge>
  )
}

export function LinearStateBadge({
  stateName,
  stateType
}: {
  stateName: string
  stateType?: string
}): React.JSX.Element {
  const normalized = stateName.toLowerCase()
  const done = stateType
    ? stateType === 'completed'
    : /done|closed|complete|completed|merged|resolved/.test(normalized)
  const cancelled = stateType
    ? stateType === 'canceled'
    : /cancel|canceled|duplicate|wontfix/.test(normalized)
  const active = stateType
    ? stateType === 'started'
    : /progress|doing|started|active/.test(normalized)
  const Icon = done ? CircleCheck : cancelled ? CircleX : active ? Clock : CircleDot
  const tone = done
    ? 'border-purple-500/25 bg-purple-500/5 text-purple-600 dark:text-purple-300'
    : cancelled
      ? 'border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-300'
      : active
        ? 'border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-300'
        : 'border-border bg-muted/30 text-muted-foreground'

  return (
    <MetadataStatusBadge
      label={translate(
        'auto.components.sidebar.WorktreeCardMetadataStatusBadges.af2b07bda5',
        'State: {{value0}}',
        { value0: stateName }
      )}
      className={tone}
    >
      <Icon />
    </MetadataStatusBadge>
  )
}

export function ReviewStateBadge({
  state,
  label
}: {
  state: WorktreeCardPrDisplay['state']
  label: 'MR' | 'PR'
}): React.JSX.Element | null {
  if (!state) {
    return null
  }

  if (state === 'merged') {
    return (
      <MetadataStatusBadge
        label={reviewStateLabel(state, label)}
        className="border-purple-500/25 bg-purple-500/5 text-purple-600 dark:text-purple-300"
      >
        <GitMerge />
      </MetadataStatusBadge>
    )
  }

  if (state === 'closed') {
    return (
      <MetadataStatusBadge
        label={reviewStateLabel(state, label)}
        className="border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-300"
      >
        <CircleX />
      </MetadataStatusBadge>
    )
  }

  if (state === 'draft') {
    return (
      <MetadataStatusBadge
        label={reviewStateLabel(state, label)}
        className="border-border bg-muted/30 text-muted-foreground"
      >
        <CircleDot />
      </MetadataStatusBadge>
    )
  }

  return (
    <MetadataStatusBadge
      label={reviewStateLabel(state, label)}
      className="border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300"
    >
      {label === 'MR' ? <GitMerge /> : <PullRequestIcon />}
    </MetadataStatusBadge>
  )
}

export function ReviewChecksBadge({
  status
}: {
  status: WorktreeCardPrDisplay['status']
}): React.JSX.Element | null {
  if (!status || status === 'neutral') {
    return null
  }

  const label = `Checks: ${checksLabel(status)}`

  if (status === 'success') {
    return (
      <MetadataStatusBadge
        label={label}
        className="border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300"
      >
        <CircleCheck />
      </MetadataStatusBadge>
    )
  }

  if (status === 'failure') {
    return (
      <MetadataStatusBadge
        label={label}
        className="border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-300"
      >
        <CircleX />
      </MetadataStatusBadge>
    )
  }

  return (
    <MetadataStatusBadge
      label={label}
      className="border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-300"
    >
      <Clock />
    </MetadataStatusBadge>
  )
}

export function reviewStateLabel(
  state: WorktreeCardPrDisplay['state'],
  label: 'MR' | 'PR'
): string {
  if (state === 'merged') {
    return translate(
      'auto.components.sidebar.WorktreeCardMetadataStatusBadges.f394b3e86e',
      'State: Merged'
    )
  }
  if (state === 'closed') {
    return translate(
      'auto.components.sidebar.WorktreeCardMetadataStatusBadges.e888362def',
      'State: Closed'
    )
  }
  if (state === 'draft') {
    return translate(
      'auto.components.sidebar.WorktreeCardMetadataStatusBadges.2931b42b09',
      'State: Draft {{value0}}',
      { value0: label }
    )
  }
  if (state === 'open') {
    return translate(
      'auto.components.sidebar.WorktreeCardMetadataStatusBadges.fe188062a1',
      'State: Open'
    )
  }
  return translate('workspace.links.checksUnknown', 'Unknown')
}

export function ReviewChecksIndicator({
  status
}: {
  status: WorktreeCardPrDisplay['status']
}): React.JSX.Element | null {
  if (!status || status === 'neutral') {
    return null
  }
  const label = `Checks: ${checksLabel(status)}`
  const Icon = status === 'success' ? CircleCheck : status === 'failure' ? CircleX : Clock
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className={cn(
            'inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
            getReviewChecksTone(status)
          )}
        >
          <Icon className="size-2.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
