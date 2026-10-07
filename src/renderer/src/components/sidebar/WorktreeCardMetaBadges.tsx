import React from 'react'
import { CalendarClock, CircleDot, SquareTerminal, StickyNote } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { MetaIconBadge } from './WorktreeCardMetadataControls'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'
import type {
  WorktreeCardMetaBadgesProps,
  WorktreeCardMetaBadgesRootProps
} from './worktree-card-meta-types'
import { translate } from '@/i18n/i18n'

function hasComment(comment: string | null): boolean {
  return (comment ?? '').trim().length > 0
}

function ReviewNumberBadge({
  review
}: {
  review: NonNullable<WorktreeCardMetaBadgesProps['review']>
}) {
  const label = translate(
    'auto.components.sidebar.WorktreeCardMeta.3ea2702e62',
    'Linked {{value0}} #{{value1}}',
    { value0: getReviewLabel(review), value1: review.number }
  )
  const className =
    'h-4 rounded-full border-worktree-sidebar-border bg-worktree-sidebar-accent/55 px-1.5 py-0 font-mono text-[10px] leading-none text-muted-foreground shadow-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'
  const content = (
    <>
      <ReviewIcon review={review} className="size-3 shrink-0" />#{review.number}
    </>
  )

  if (review.url) {
    return (
      <Badge asChild variant="outline" className={className}>
        <a
          href={review.url}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          data-worktree-review-number=""
          onClick={(event) => event.stopPropagation()}
        >
          {content}
        </a>
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className={className}
      aria-label={label}
      data-worktree-review-number=""
    >
      {content}
    </Badge>
  )
}

export function hasWorktreeCardDetails({
  issue,
  linearIssue,
  jiraIssue,
  review,
  comment,
  automationProvenance,
  cliProvenance
}: WorktreeCardMetaBadgesProps): boolean {
  return Boolean(
    issue ||
    linearIssue ||
    jiraIssue ||
    review ||
    hasComment(comment) ||
    automationProvenance ||
    cliProvenance
  )
}

export const WorktreeCardMetaBadges = React.forwardRef<
  HTMLDivElement,
  WorktreeCardMetaBadgesRootProps
>(function WorktreeCardMetaBadges(
  {
    issue,
    linearIssue,
    jiraIssue,
    review,
    comment,
    automationProvenance,
    cliProvenance,
    className,
    ...props
  },
  ref
): React.JSX.Element | null {
  if (
    !hasWorktreeCardDetails({
      issue,
      linearIssue,
      jiraIssue,
      review,
      comment,
      automationProvenance,
      cliProvenance
    })
  ) {
    return null
  }

  return (
    // Why: Radix HoverCardTrigger uses `asChild`, so this group must forward
    // trigger props/ref to the actual DOM node for attachment-only hover.
    <div
      ref={ref}
      {...props}
      className={cn('ml-auto flex shrink-0 items-center gap-1 pr-1.5', className)}
      aria-label={translate(
        'auto.components.sidebar.WorktreeCardMeta.3e65e11cc6',
        'Workspace metadata'
      )}
    >
      {hasComment(comment) && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.fe075cb851',
            'Workspace notes'
          )}
        >
          <StickyNote className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {automationProvenance && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.automationCreated',
            'Created by automation'
          )}
        >
          <CalendarClock className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {cliProvenance && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.cliCreated',
            'Created by Orca CLI'
          )}
        >
          <SquareTerminal className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {issue && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.3f2649eeb8',
            'Linked issue #{{value0}}',
            { value0: issue.number }
          )}
        >
          <CircleDot className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {linearIssue && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.b105fd3057',
            'Linked Linear {{value0}}',
            { value0: linearIssue.identifier }
          )}
        >
          <LinearIcon className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {jiraIssue && (
        <MetaIconBadge
          label={translate(
            'auto.components.sidebar.WorktreeCardMeta.linkedJira',
            'Linked Jira {{value0}}',
            { value0: jiraIssue.identifier }
          )}
        >
          <JiraIcon className="text-muted-foreground" />
        </MetaIconBadge>
      )}
      {review && <ReviewNumberBadge review={review} />}
    </div>
  )
})
