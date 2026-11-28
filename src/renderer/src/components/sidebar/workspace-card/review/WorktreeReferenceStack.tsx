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
import { cn } from '@/lib/class-names'
import { WorktreeCardReferencePeekContext } from '../details/worktree-card-reference-peek-context'
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

// The peek sits inside the card, inset this far from its edges and between the width bounds.
const PEEK_CARD_INSET = 8
const PEEK_MAX_WIDTH = 300
// Deeply nested cards get too narrow to read; the peek then extends left past the card.
const PEEK_MIN_WIDTH = 176
const PEEK_SCROLL_STEP = 28

type PeekGeometry = { width: number; alignOffset: number }

// Right-aligns the peek to the card's inner edge so narrow sidebars never clip it.
function measurePeek(trigger: HTMLElement): PeekGeometry | null {
  const card = trigger.closest('[data-worktree-card-surface]')
  if (!card) {
    return null
  }
  const cardRect = card.getBoundingClientRect()
  const triggerRect = trigger.getBoundingClientRect()
  return {
    width: Math.max(PEEK_MIN_WIDTH, Math.min(cardRect.width - 2 * PEEK_CARD_INSET, PEEK_MAX_WIDTH)),
    // Radix shifts an end-aligned popper left by a positive offset.
    alignOffset: triggerRect.right - (cardRect.right - PEEK_CARD_INSET)
  }
}

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
    // Why: rows too narrow for one line move the title to a second grid row instead of hiding it.
    <li className="flex min-w-0 items-center gap-x-2 py-0.5 whitespace-nowrap @max-[8rem]:grid @max-[8rem]:grid-cols-[0.875rem_minmax(0,max-content)_minmax(0,max-content)]">
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">
        <ReferenceGlyph item={item} details={details} />
      </span>
      {/* Why: caps the key at the row minus the title's 25% and the icon and gaps. */}
      <span className="max-w-[calc(75%-2.375rem)] shrink-0 truncate font-medium tabular-nums @max-[8rem]:max-w-none">
        {workspaceAttachmentReferenceLabel(item, PEEK_LABELS)}
      </span>
      <span className="min-w-[25%] flex-1 truncate text-muted-foreground @max-[8rem]:col-span-2 @max-[8rem]:col-start-2 @max-[8rem]:row-start-2 @max-[8rem]:min-w-0">
        {detail?.title}
      </span>
      {status ? (
        // Why: long keys or custom issue states must not squeeze the title away in a narrow peek.
        <span className="max-w-[40%] min-w-0 truncate text-muted-foreground @max-[8rem]:col-start-3 @max-[8rem]:row-start-1 @max-[8rem]:max-w-none">
          {status}
        </span>
      ) : null}
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
  return (
    <ReferencePeek
      items={items}
      ordered={ordered}
      details={details}
      kind={kind}
      summary={summary}
    />
  )
}

// Memoized so re-clamping the open peek doesn't re-render every row.
const ReferencePeekList = React.memo(function ReferencePeekList({
  listRef,
  ordered,
  details
}: {
  listRef: React.RefObject<HTMLUListElement | null>
  ordered: readonly WorkspaceAttachment[]
  details: WorkspaceReferenceDetailsMap
}): React.JSX.Element {
  return (
    <ul
      ref={listRef}
      // Why: spans the padded card so the scrollbar sits on its edge; short windows shrink the cap.
      className="scrollbar-sleek @container -m-3 flex max-h-[min(10.5rem,calc(var(--radix-tooltip-content-available-height)-2px))] flex-col overflow-x-hidden overflow-y-auto p-3"
    >
      {ordered.map((item) => (
        <ReferencePeekRow key={getWorkspaceAttachmentKey(item)} item={item} details={details} />
      ))}
    </ul>
  )
})

function ReferencePeek({
  items,
  ordered,
  details,
  kind,
  summary
}: {
  items: readonly WorkspaceAttachment[]
  ordered: readonly WorkspaceAttachment[]
  details: WorkspaceReferenceDetailsMap
  kind: string
  summary: string
}): React.JSX.Element {
  const t = useTranslate()
  const triggerRef = React.useRef<HTMLSpanElement>(null)
  const listRef = React.useRef<HTMLUListElement>(null)
  const [geometry, setGeometry] = React.useState<PeekGeometry | null>(null)
  const [open, setOpen] = React.useState(false)
  const front = ordered[0]
  const reportPeekOpen = React.useContext(WorktreeCardReferencePeekContext)
  // Why: a focus-opened peek must keep the card's details hover shut wherever the pointer rests.
  React.useEffect(() => {
    if (!open || !reportPeekOpen) {
      return
    }
    reportPeekOpen(true)
    return () => reportPeekOpen(false)
  }, [open, reportPeekOpen])
  React.useEffect(() => {
    const trigger = triggerRef.current
    const card = trigger?.closest('[data-worktree-card-surface]')
    if (!open || !trigger || !card) {
      return
    }
    // Re-clamp when the card resizes or its title row reflows the glyph.
    const remeasure = (): void =>
      setGeometry((previous) => {
        const next = measurePeek(trigger)
        return previous &&
          next &&
          previous.width === next.width &&
          previous.alignOffset === next.alignOffset
          ? previous
          : next
      })
    const resize = new ResizeObserver(remeasure)
    resize.observe(card)
    const reflow = new MutationObserver(remeasure)
    reflow.observe(card, { childList: true, subtree: true, characterData: true })
    return () => {
      resize.disconnect()
      reflow.disconnect()
    }
  }, [open])
  return (
    <Tooltip
      delayDuration={200}
      // Why: the pointer must reach the list to scroll it.
      disableHoverableContent={false}
      onOpenChange={(next) => {
        if (next && triggerRef.current) {
          setGeometry(measurePeek(triggerRef.current))
        }
        setOpen(next)
      }}
    >
      <TooltipTrigger asChild>
        <span
          ref={triggerRef}
          onKeyDown={(event) => {
            const list = listRef.current
            const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
            if (list && step && list.scrollHeight > list.clientHeight) {
              // Why: arrows scroll the open peek instead of moving sidebar focus.
              event.preventDefault()
              event.stopPropagation()
              list.scrollBy({ top: step * PEEK_SCROLL_STEP })
            }
          }}
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
        variant="tab-preview-interactive"
        side="bottom"
        align="end"
        sideOffset={6}
        alignOffset={geometry?.alignOffset ?? 0}
        collisionPadding={PEEK_CARD_INSET}
        showArrow={false}
        className={cn('overflow-hidden', geometry ? 'max-w-none' : 'w-72')}
        style={geometry ? { width: geometry.width } : undefined}
        // Why: pointer moves inside the portaled peek bubble to the card; keep its details card shut.
        data-activity-thread-control=""
        // Why: React bubbles portal wheels to the sidebar, whose handler treats them as list scrolls.
        onWheel={(event) => event.stopPropagation()}
      >
        <ReferencePeekList listRef={listRef} ordered={ordered} details={details} />
      </TooltipContent>
    </Tooltip>
  )
}
