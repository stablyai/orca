import React from 'react'
import { CircleDot } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { ReviewIcon } from './worktree-review-presentation'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { workspaceAttachmentLabel } from '../metadata/worktree-attachment-editing'
import {
  workspaceReferenceReview,
  type WorkspaceReferenceDetails,
  type WorkspaceReferenceDetailsMap
} from './workspace-reference-details'
import { workspaceAttachmentReferenceLabel } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import '../activity/worktree-card-empty-inputs'
import { checksLabel } from './workspace-review-check-label'
const EMPTY_DETAILS: WorkspaceReferenceDetailsMap = {}

function singleReferenceLabel(item: WorkspaceAttachment, t: Translate = translate): string {
  if (item.provider === 'linear') {
    return t('auto.components.sidebar.WorktreeCardMeta.b105fd3057', 'Linked Linear {{value0}}', {
      value0: item.identifier ?? item.linearIdentifier
    })
  }
  if (item.provider === 'jira') {
    return t('auto.components.sidebar.WorktreeCardMeta.linkedJira', 'Linked Jira {{value0}}', {
      value0: item.identifier ?? item.jiraIdentifier
    })
  }
  return item.type === 'issue'
    ? t('auto.components.sidebar.WorktreeCardMeta.3f2649eeb8', 'Linked issue #{{value0}}', {
        value0: item.number
      })
    : t('auto.components.sidebar.WorktreeCardMeta.3ea2702e62', 'Linked {{value0}} #{{value1}}', {
        value0: item.type === 'mr' ? 'MR' : 'PR',
        value1: item.number
      })
}

function ReferenceGlyph({
  item,
  details
}: {
  item: WorkspaceAttachment
  details: WorkspaceReferenceDetailsMap
}): React.JSX.Element {
  const review = workspaceReferenceReview(item, details[getWorkspaceAttachmentKey(item)])
  if (review) {
    return <ReviewIcon review={review} />
  }
  if (item.provider === 'linear') {
    return <LinearIcon className="text-muted-foreground" />
  }
  if (item.provider === 'jira') {
    return <JiraIcon className="text-muted-foreground" />
  }
  return <CircleDot className="text-muted-foreground" />
}

function priority(item: WorkspaceAttachment, details: WorkspaceReferenceDetailsMap): number {
  const key = getWorkspaceAttachmentKey(item)
  const detail = details[key]
  if (item.type !== 'issue') {
    const review = detail?.review
    const status = review && getProviderChecksOutcome(review.checksSummary, review.status)
    return review?.state === 'open'
      ? status === 'failure'
        ? 0
        : status === 'pending'
          ? 1
          : status === 'cancelled'
            ? 2
            : 3
      : review?.state === 'draft'
        ? 4
        : review?.state === 'merged'
          ? 5
          : review?.state === 'closed'
            ? 6
            : 7
  }
  const state = detail?.stateName?.toLowerCase() ?? ''
  if (detail?.stateType) {
    return detail.stateType === 'started'
      ? 0
      : detail.stateType === 'unstarted' || detail.stateType === 'backlog'
        ? 1
        : detail.stateType === 'completed'
          ? 2
          : detail.stateType === 'canceled'
            ? 3
            : 4
  }
  return /progress|started|doing|active/.test(state)
    ? 0
    : /todo|backlog|unstarted/.test(state)
      ? 1
      : /done|complete|resolved/.test(state)
        ? 2
        : /cancel|duplicate/.test(state)
          ? 3
          : 4
}

// One reference per peek row; past this the list folds into "+N more".
const PEEK_ROW_LIMIT = 8

function openReviewStatus(review: WorktreeCardPrDisplay, t: Translate): string {
  switch (getProviderChecksOutcome(review.checksSummary, review.status)) {
    case 'failure':
      return t('workspace.links.peek.failing', 'failing')
    case 'pending':
      return t('workspace.links.peek.running', 'running')
    case 'cancelled':
      return t('workspace.links.peek.cancelled', 'cancelled')
    case 'success':
      return t('workspace.links.peek.passing', 'passing')
    case 'neutral':
    case 'none':
    case 'unknown':
    case undefined:
      return t('workspace.links.peek.open', 'open')
  }
}

function referenceStatus(
  item: WorkspaceAttachment,
  detail: WorkspaceReferenceDetails | undefined,
  t: Translate
): string {
  const review = detail?.review
  if (item.type === 'issue') {
    if (detail?.stateName) {
      return detail.stateName
    }
    return detail?.issueState === 'closed'
      ? t('workspace.links.peek.closed', 'closed')
      : detail?.issueState === 'open'
        ? t('workspace.links.peek.open', 'open')
        : ''
  }
  switch (review?.state) {
    case 'merged':
      return t('workspace.links.peek.merged', 'merged')
    case 'closed':
      return t('workspace.links.peek.closed', 'closed')
    case 'draft':
      return t('workspace.links.peek.draft', 'draft')
    case 'open':
      return openReviewStatus(review, t)
    case undefined:
      return ''
  }
}

function ReferencePeekRow({
  item,
  details
}: {
  item: WorkspaceAttachment
  details: WorkspaceReferenceDetailsMap
}): React.JSX.Element {
  const t = useTranslate()
  const detail = details[getWorkspaceAttachmentKey(item)]
  const status = referenceStatus(item, detail, t)
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5 whitespace-nowrap">
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">
        <ReferenceGlyph item={item} details={details} />
      </span>
      <span className="shrink-0 font-medium tabular-nums">
        {workspaceAttachmentReferenceLabel(item, PEEK_LABELS)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail?.title}</span>
      {status ? <span className="shrink-0 text-muted-foreground">{status}</span> : null}
    </li>
  )
}

const PEEK_LABELS = {
  mr: (number: number) => `!${number}`,
  pr: (number: number) => `#${number}`,
  issue: (number: number) => `#${number}`
}

export function WorktreeReferenceStack({
  items,
  details = EMPTY_DETAILS
}: {
  items: readonly WorkspaceAttachment[]
  details?: WorkspaceReferenceDetailsMap
}): React.JSX.Element | null {
  const t = useTranslate()
  const ordered = [...items].sort((a, b) => priority(a, details) - priority(b, details))
  const front = ordered[0]
  if (!front) {
    return null
  }
  const kind = front.type === 'issue' ? front.provider : 'review'
  if (items.length === 1) {
    return (
      <span className="workspace-reference-stack" data-workspace-reference-stack={kind}>
        <span className="workspace-reference-stack-front" data-reference-front="" aria-hidden>
          <ReferenceGlyph item={front} details={details} />
        </span>
        <span className="sr-only">{singleReferenceLabel(front, t)}</span>
      </span>
    )
  }
  const summary = ordered
    .map((item) => {
      const detail = details[getWorkspaceAttachmentKey(item)]
      const review = detail?.review
      const status = review && getProviderChecksOutcome(review.checksSummary, review.status)
      return [
        workspaceAttachmentLabel(item),
        review?.state ?? detail?.stateName,
        status === 'cancelled' ? checksLabel(status, t) : status
      ]
        .filter(Boolean)
        .join(' · ')
    })
    .join(', ')
  const hidden = ordered.length - PEEK_ROW_LIMIT
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={t('workspace.links.stackSummary', '{{count}} linked: {{references}}', {
            count: items.length,
            references: summary
          })}
          className="workspace-reference-stack rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-workspace-reference-stack={kind}
          // Why: the peek replaces the card's details hover while the pointer or focus is here.
          data-activity-thread-control=""
        >
          <span className="workspace-reference-stack-front" data-reference-front="" aria-hidden>
            <ReferenceGlyph item={front} details={details} />
          </span>
          <span
            className="workspace-reference-stack-count text-3xs leading-none font-medium text-muted-foreground"
            data-reference-count=""
            aria-hidden
          >
            {items.length}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        variant="tab-preview"
        side="right"
        sideOffset={8}
        showArrow={false}
        className="w-auto max-w-72 min-w-44"
      >
        <ul className="flex flex-col">
          {ordered.slice(0, PEEK_ROW_LIMIT).map((item) => (
            <ReferencePeekRow key={getWorkspaceAttachmentKey(item)} item={item} details={details} />
          ))}
        </ul>
        {hidden > 0 ? (
          <div className="py-0.5 text-muted-foreground">
            {t('workspace.links.peek.more', '+{{count}} more', { count: hidden })}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
