import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getReviewChecksTone } from '../review/worktree-review-presentation'
import { Badge } from '@/components/ui/badge'
import { CircleCheck, CircleDot, CircleX, Clock, GitMerge } from 'lucide-react'
import { cn } from '@/lib/class-names'
import '../activity/worktree-card-empty-inputs'
import { PullRequestIcon } from '../identity/worktree-card-glyphs'
import { checksLabel } from '../review/workspace-review-check-label'
import type { WorktreeCardPrDisplay } from '../review/worktree-card-pr-display'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

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

export function ReviewStateBadge({
  state,
  label
}: {
  state: WorktreeCardPrDisplay['state']
  label: 'MR' | 'PR'
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!state) {
    return null
  }

  if (state === 'merged') {
    return (
      <MetadataStatusBadge
        label={reviewStateLabel(state, label, t)}
        className="border-purple-500/25 bg-purple-500/5 text-purple-600 dark:text-purple-300"
      >
        <GitMerge />
      </MetadataStatusBadge>
    )
  }

  if (state === 'closed') {
    return (
      <MetadataStatusBadge
        label={reviewStateLabel(state, label, t)}
        className="border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-300"
      >
        <CircleX />
      </MetadataStatusBadge>
    )
  }

  if (state === 'draft') {
    return (
      <MetadataStatusBadge
        label={reviewStateLabel(state, label, t)}
        className="border-border bg-muted/30 text-muted-foreground"
      >
        <CircleDot />
      </MetadataStatusBadge>
    )
  }

  return (
    <MetadataStatusBadge
      label={reviewStateLabel(state, label, t)}
      className="border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300"
    >
      {label === 'MR' ? <GitMerge /> : <PullRequestIcon />}
    </MetadataStatusBadge>
  )
}

export function ReviewChecksBadge({
  status: coarseStatus,
  checksSummary
}: {
  checksSummary?: WorktreeCardPrDisplay['checksSummary']
  status: WorktreeCardPrDisplay['status']
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = coarseStatus ? getProviderChecksOutcome(checksSummary, coarseStatus) : undefined
  if (!status || status === 'neutral') {
    return null
  }

  const label = t(
    'auto.components.sidebar.WorktreeCardMetadataStatusBadges.checksStatus',
    'Checks: {{status}}',
    {
      status: checksLabel(status, t)
    }
  )

  if (status === 'cancelled') {
    return (
      <MetadataStatusBadge
        label={label}
        className="border-border bg-muted/30 text-muted-foreground"
      >
        <CircleX />
      </MetadataStatusBadge>
    )
  }
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
  label: 'MR' | 'PR',
  t: Translate = translate
): string {
  if (state === 'merged') {
    return t('auto.components.sidebar.WorktreeCardMetadataStatusBadges.f394b3e86e', 'State: Merged')
  }
  if (state === 'closed') {
    return t('auto.components.sidebar.WorktreeCardMetadataStatusBadges.e888362def', 'State: Closed')
  }
  if (state === 'draft') {
    return t(
      'auto.components.sidebar.WorktreeCardMetadataStatusBadges.2931b42b09',
      'State: Draft {{value0}}',
      { value0: label }
    )
  }
  if (state === 'open') {
    return t('auto.components.sidebar.WorktreeCardMetadataStatusBadges.fe188062a1', 'State: Open')
  }
  return t('workspace.links.checksUnknown', 'Unknown')
}

export function ReviewChecksIndicator({
  status: coarseStatus,
  checksSummary
}: {
  checksSummary?: WorktreeCardPrDisplay['checksSummary']
  status: WorktreeCardPrDisplay['status']
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = coarseStatus ? getProviderChecksOutcome(checksSummary, coarseStatus) : undefined
  if (!status || status === 'neutral') {
    return null
  }
  const label = t(
    'auto.components.sidebar.WorktreeCardMetadataStatusBadges.checksStatus',
    'Checks: {{status}}',
    {
      status: checksLabel(status, t)
    }
  )
  const Icon =
    status === 'success'
      ? CircleCheck
      : status === 'failure' || status === 'cancelled'
        ? CircleX
        : Clock
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
