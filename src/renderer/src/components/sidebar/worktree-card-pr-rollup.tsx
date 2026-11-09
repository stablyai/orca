import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  lineageIdentities,
  type WorktreeLineageSource
} from '../../../../shared/sidebar-list/worktree-lineage-range'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { toast } from 'sonner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { WorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-display'
import {
  getReviewLabel,
  getReviewTone,
  ReviewIcon
} from './workspace-card/review/worktree-review-presentation'
import { worktreeForIdentity } from './worktree-card-slot-rollup'

import {
  REVIEW_STATE_ORDER as STATE_ORDER,
  mergeReviewSummary as merge,
  addReview as add,
  ownWorktreeReview as ownReview,
  createHiddenReviewStatesSelector,
  type PrStates,
  type ReviewRollupState
} from './worktree-card-review-range'

type ReviewTarget = { worktree: Worktree; review: WorktreeCardPrDisplay }

function stateLabel(state: ReviewRollupState, count: number, t: Translate): string {
  switch (state) {
    case 'open':
      return t('sidebar.cardSlot.prOpen', '{{count}} open', { count })
    case 'draft':
      return t('sidebar.cardSlot.prDraft', '{{count}} draft', { count })
    case 'merged':
      return t('sidebar.cardSlot.prMerged', '{{count}} merged', { count })
    case 'closed':
      return t('sidebar.cardSlot.prClosed', '{{count}} closed', { count })
    case 'unknown':
      return t('workspace.links.reviews', 'Reviews')
  }
}

export function WorktreeCardPrRollup({
  own,
  hiddenDescendants,
  onOpenOwn,
  ownRepresentsDescendant = false
}: {
  own: WorktreeCardPrDisplay | null
  ownRepresentsDescendant?: boolean
  hiddenDescendants: WorktreeLineageSource
  onOpenOwn: (event: React.MouseEvent) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const select = useMemo(
    () => createHiddenReviewStatesSelector(hiddenDescendants),
    [hiddenDescendants]
  )
  const hidden = useAppStore(useShallow(select))
  const [reviews, setReviews] = useState<ReviewTarget[]>([])
  const states: PrStates = {
    open: { ...hidden.open },
    draft: { ...hidden.draft },
    merged: { ...hidden.merged },
    closed: { ...hidden.closed },
    unknown: { ...hidden.unknown }
  }
  const hasHidden = STATE_ORDER.some((key) => hidden[key].count > 0)
  const ownState = own?.state ?? 'unknown'
  if (ownRepresentsDescendant && own && hidden[ownState].count > 0) {
    merge(states[ownState], { count: 0, review: own })
  } else {
    add(states, own)
  }
  const shown = STATE_ORDER.filter((key) => states[key].count > 0)
  if (!own && shown.length === 0) {
    return null
  }
  const icons = (
    <>
      {shown.map((state) => (
        <span
          key={state}
          className={cn('worktree-card-pr-state', getReviewTone(states[state].review!))}
          title={stateLabel(state, states[state].count, t)}
          data-pr-state={state}
        >
          <ReviewIcon review={states[state].review!} className="size-3 shrink-0" />
          {states[state].count > 1 ? (
            <span className="worktree-card-pr-count" aria-hidden>
              {states[state].count}
            </span>
          ) : null}
        </span>
      ))}
    </>
  )
  const buttonClass =
    'inline-flex shrink-0 items-center gap-1 rounded-sm p-0.5 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  if (!hasHidden) {
    return (
      <button
        type="button"
        className={buttonClass}
        data-worktree-card-prs=""
        aria-label={`${getReviewLabel(own!)} #${own!.number}: ${own!.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onOpenOwn}
      >
        {icons}
      </button>
    )
  }
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          const state = useAppStore.getState()
          const next: ReviewTarget[] = []
          for (const identity of lineageIdentities(hiddenDescendants)) {
            const worktree = worktreeForIdentity(state, identity)
            const review = worktree && ownReview(state, worktree)
            if (worktree && review) {
              next.push({ worktree, review })
            }
          }
          setReviews(next)
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={buttonClass}
          data-worktree-card-prs=""
          aria-label={t('workspace.links.openItem', 'Open {{label}}', {
            label: t('workspace.links.reviews', 'Reviews')
          })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {icons}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent onClick={(event) => event.stopPropagation()} align="end">
        {own ? (
          <DropdownMenuItem onClick={onOpenOwn}>
            <ReviewIcon review={own} className="size-3" />
            {getReviewLabel(own)} #{own.number}: {own.title}
          </DropdownMenuItem>
        ) : null}
        {reviews.map(({ worktree, review }) => (
          <DropdownMenuItem
            key={`${getWorktreeHostIdentity(worktree)}:${review.provider}:${review.number}`}
            onSelect={() => {
              activateAndRevealWorkspace(worktree.id, { executionHostId: worktree.hostId })
              if (review.url) {
                void openWorkspaceBrowserTab({
                  workspaceId: worktree.id,
                  url: review.url,
                  intent: { kind: 'url' }
                }).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
                )
              }
            }}
          >
            <ReviewIcon review={review} className="size-3" />
            <span className="max-w-72 truncate">
              {worktree.displayName} · {getReviewLabel(review)} #{review.number}: {review.title}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
