import React from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { CircleCheck, CircleDot, CircleX, Clock, GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { checksLabel } from './WorktreeCardHelpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { IssueInfo } from '../../../../shared/types'

function MetadataStatusIcon({
  label,
  children,
  className
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-sidebar-ring [&>svg]:size-3.5',
            className
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function IssueStateIcon({ state }: { state: IssueInfo['state'] }): React.JSX.Element {
  if (state === 'closed') {
    return (
      <MetadataStatusIcon
        label="Issue closed"
        className="text-purple-600/80 dark:text-purple-400/80"
      >
        <CircleCheck />
      </MetadataStatusIcon>
    )
  }

  return (
    <MetadataStatusIcon label="Issue open" className="text-emerald-500/80">
      <CircleDot />
    </MetadataStatusIcon>
  )
}

export function LinearStateIcon({ stateName }: { stateName: string }): React.JSX.Element {
  const normalized = stateName.toLowerCase()
  const done = /done|closed|complete|completed|merged|resolved/.test(normalized)
  const cancelled = /cancel|canceled|duplicate|wontfix/.test(normalized)
  const active = /progress|doing|started|active/.test(normalized)
  const Icon = done ? CircleCheck : cancelled ? CircleX : active ? Clock : CircleDot
  const tone = done
    ? 'text-purple-600/80 dark:text-purple-400/80'
    : cancelled
      ? 'text-rose-500/80'
      : active
        ? 'text-amber-500/85'
        : 'text-muted-foreground/80'

  return (
    <MetadataStatusIcon label={`Linear state: ${stateName}`} className={tone}>
      <Icon />
    </MetadataStatusIcon>
  )
}

export function ReviewStateIcon({
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
      <MetadataStatusIcon
        label={`${label} merged`}
        className="text-purple-600/80 dark:text-purple-400/80"
      >
        <GitMerge />
      </MetadataStatusIcon>
    )
  }

  if (state === 'closed') {
    return (
      <MetadataStatusIcon label={`${label} closed`} className="text-rose-500/80">
        <CircleX />
      </MetadataStatusIcon>
    )
  }

  if (state === 'draft') {
    return (
      <MetadataStatusIcon label={`Draft ${label}`} className="text-muted-foreground/70">
        <CircleDot />
      </MetadataStatusIcon>
    )
  }

  return (
    <MetadataStatusIcon label={`${label} open`} className="text-emerald-500/80">
      <CircleDot />
    </MetadataStatusIcon>
  )
}

export function ReviewChecksIcon({
  status
}: {
  status: WorktreeCardPrDisplay['status']
}): React.JSX.Element | null {
  if (!status || status === 'neutral') {
    return null
  }

  const label = `Checks ${checksLabel(status).toLowerCase()}`

  if (status === 'success') {
    return (
      <MetadataStatusIcon label={label} className="text-emerald-500/80">
        <CircleCheck />
      </MetadataStatusIcon>
    )
  }

  if (status === 'failure') {
    return (
      <MetadataStatusIcon label={label} className="text-rose-500/80">
        <CircleX />
      </MetadataStatusIcon>
    )
  }

  return (
    <MetadataStatusIcon label={label} className="text-amber-500/85">
      <Clock />
    </MetadataStatusIcon>
  )
}
