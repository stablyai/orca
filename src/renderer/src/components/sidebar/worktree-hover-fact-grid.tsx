import React from 'react'
import { Bell, CircleDot, ExternalLink, GitMerge, Pin, Plug, Server, Workflow } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { checksLabel } from './WorktreeCardHelpers'
import { ReviewIcon } from './worktree-review-helpers'
import type { WorktreeHoverFacts } from './worktree-hover-facts'

const CELL_CLASS_NAME =
  'flex min-w-0 items-center gap-1.5 text-[10.5px] leading-none text-muted-foreground'
const ICON_BOX_CLASS_NAME = 'flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3'

/**
 * One fact: a fixed-width icon box so every row's glyph lines up in its column,
 * then the value. The full label lives in the tooltip.
 */
export function HoverFactCell({
  icon,
  label,
  tooltip,
  className,
  onOpen
}: {
  icon: React.ReactNode
  label: React.ReactNode
  tooltip: string
  className?: string
  /** Given a destination, the cell becomes the way there. */
  onOpen?: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const content = (
    <>
      <span className={ICON_BOX_CLASS_NAME}>{icon}</span>
      <span className="truncate tabular-nums">{label}</span>
    </>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onOpen ? (
          <button
            type="button"
            className={cn(
              CELL_CLASS_NAME,
              'group/fact rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
              className
            )}
            aria-label={tooltip}
            data-worktree-hover-fact=""
            onClick={onOpen}
          >
            {content}
            <ExternalLink className="size-2.5 shrink-0 opacity-0 transition-opacity group-hover/fact:opacity-70" />
          </button>
        ) : (
          <span
            className={cn(CELL_CLASS_NAME, className)}
            aria-label={tooltip}
            data-worktree-hover-fact=""
          >
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** A state flag with no value of its own; these share one row so they stay aligned. */
function FactMarker({
  tooltip,
  className,
  children
}: {
  tooltip: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(ICON_BOX_CLASS_NAME, 'text-muted-foreground', className)}
          aria-label={tooltip}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeHoverFactGrid({
  facts,
  workspaceSlot
}: {
  facts: WorktreeHoverFacts
  workspaceSlot?: React.ReactNode
}): React.JSX.Element | null {
  const { review, issue, linearIssue, jiraIssue } = facts
  const cells: React.ReactNode[] = []
  const markers: React.ReactNode[] = []

  if (review?.number) {
    const checks = review.status && review.status !== 'neutral' ? checksLabel(review.status) : ''
    const reviewLabel = review.provider === 'gitlab' ? 'MR' : 'PR'
    const reviewTooltip = [
      `${reviewLabel} ${review.state ?? 'open'}`,
      checks && `checks ${checks.toLowerCase()}`
    ]
      .filter(Boolean)
      .join(' · ')
    cells.push(
      <HoverFactCell
        key="review"
        icon={<ReviewIcon review={review} />}
        label={`#${review.number}`}
        tooltip={reviewTooltip}
        onOpen={facts.links?.openReview}
      />
    )
  }
  if (issue?.number) {
    cells.push(
      <HoverFactCell
        key="issue"
        icon={<CircleDot />}
        label={`#${issue.number}`}
        tooltip={
          issue.title ??
          translate('auto.components.sidebar.worktreeHoverCard.issue', 'Issue #{{number}}', {
            number: issue.number
          })
        }
        onOpen={facts.links?.openIssue}
      />
    )
  }
  if (linearIssue) {
    cells.push(
      <HoverFactCell
        key="linear"
        icon={<LinearIcon />}
        label={
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{linearIssue.identifier}</span>
            {facts.linearStateColor && (
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: facts.linearStateColor }}
              />
            )}
          </span>
        }
        tooltip={linearIssue.stateName ?? linearIssue.title}
        onOpen={facts.links?.openLinearIssue}
      />
    )
  }
  if (jiraIssue) {
    cells.push(
      <HoverFactCell
        key="jira"
        icon={<JiraIcon />}
        label={jiraIssue.identifier}
        tooltip={jiraIssue.title}
        onOpen={facts.links?.openJiraIssue}
      />
    )
  }
  if (facts.repoName) {
    cells.push(
      <HoverFactCell
        key="repo"
        icon={<RepoIconGlyph repoIcon={facts.repoIcon ?? null} iconClassName="size-3" />}
        label={facts.repoName}
        tooltip={facts.repoName}
      />
    )
  }
  if (facts.hostLabel) {
    cells.push(
      <HoverFactCell
        key="host"
        icon={<Server />}
        label={facts.hostLabel}
        tooltip={facts.hostLabel}
      />
    )
  }
  if (facts.portCount > 0) {
    cells.push(
      <HoverFactCell
        key="ports"
        icon={<Plug />}
        label={facts.portLabels.join(', ')}
        tooltip={facts.portLabels.join(', ')}
      />
    )
  }
  if (facts.childWorkspaceCount > 0) {
    // Why the explicit key: the localization gate wants every key it can see, so the
    // plural form is chosen here rather than left to i18next's suffix lookup.
    const childLabel =
      facts.childWorkspaceCount === 1
        ? translate(
            'auto.components.sidebar.worktreeHoverCard.childWorkspaces_one',
            '{{count}} child workspace',
            { count: facts.childWorkspaceCount }
          )
        : translate(
            'auto.components.sidebar.worktreeHoverCard.childWorkspaces_other',
            '{{count}} child workspaces',
            { count: facts.childWorkspaceCount }
          )
    cells.push(
      <HoverFactCell
        key="children"
        icon={<Workflow />}
        label={facts.childWorkspaceCount}
        tooltip={childLabel}
      />
    )
  }

  if (facts.isUnread) {
    markers.push(
      <FactMarker
        key="unread"
        tooltip={translate('auto.components.sidebar.worktreeHoverCard.unread', 'Unread activity')}
      >
        <Bell />
      </FactMarker>
    )
  }
  if (facts.isPinned) {
    markers.push(
      <FactMarker
        key="pinned"
        tooltip={translate('auto.components.sidebar.worktreeHoverCard.pinned', 'Pinned')}
      >
        <Pin />
      </FactMarker>
    )
  }
  if (facts.conflictOperation) {
    markers.push(
      <FactMarker
        key="conflict"
        tooltip={facts.conflictOperation}
        className="text-annotation-highlight"
      >
        <GitMerge />
      </FactMarker>
    )
  }

  if (cells.length === 0 && markers.length === 0 && !workspaceSlot) {
    return null
  }

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {workspaceSlot}
      {cells}
      {markers.length > 0 && <div className="col-span-2 flex items-center gap-2.5">{markers}</div>}
    </div>
  )
}
