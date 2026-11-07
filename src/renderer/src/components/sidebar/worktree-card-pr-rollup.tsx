import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { createHostScopedRepoOf } from '../../../../shared/sidebar-list/sidebar-feed-index'
import {
  isLineageRange,
  lineageIdentities,
  type WorktreeLineageSource,
  type WorktreeLineageTree
} from '../../../../shared/sidebar-list/worktree-lineage-range'
import type { HostedReviewState } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getProviderChecksOutcome } from '../../../../shared/source-control/checks/provider-check-summary'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { openWorkspaceBrowserTab } from '@/lib/browser/workspace/workspace-browser-tab-open'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { selectWorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-derivation'
import type { WorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-display'
import {
  getReviewLabel,
  getReviewTone,
  ReviewIcon
} from './workspace-card/review/worktree-review-presentation'
import { worktreeForIdentity } from './worktree-card-slot-rollup'

const STATE_ORDER: readonly HostedReviewState[] = ['open', 'draft', 'merged', 'closed']
type ReviewTarget = { worktree: Worktree; review: WorktreeCardPrDisplay }
type PrSummary = { count: number; review: WorktreeCardPrDisplay | null }
type PrStates = Record<HostedReviewState, PrSummary>
const emptyStates = (): PrStates => ({
  open: { count: 0, review: null },
  draft: { count: 0, review: null },
  merged: { count: 0, review: null },
  closed: { count: 0, review: null }
})

function priority(review: WorktreeCardPrDisplay): number {
  const outcome = review.status && getProviderChecksOutcome(review.checksSummary, review.status)
  return outcome === 'failure' ? 0 : outcome === 'pending' ? 1 : outcome === 'cancelled' ? 2 : 3
}
function merge(into: PrSummary, from: PrSummary): void {
  into.count += from.count
  if (from.review && (!into.review || priority(from.review) < priority(into.review))) {
    into.review = from.review
  }
}
function add(states: PrStates, review: WorktreeCardPrDisplay | null): void {
  if (review?.state) {
    merge(states[review.state], { count: 1, review })
  }
}
const treeStates = new WeakMap<
  WorktreeLineageTree,
  { inputs: readonly unknown[]; states: PrStates[] }
>()
function reviewInputs(state: AppState): readonly unknown[] {
  return [
    selectWorktreesByRepo(state),
    state.repos,
    state.settings,
    state.prCache,
    state.hostedReviewCache
  ]
}
const repoReaders = new WeakMap<AppState['repos'], ReturnType<typeof createHostScopedRepoOf>>()
function ownReview(state: AppState, worktree: Worktree): WorktreeCardPrDisplay | null {
  let repoOf = repoReaders.get(state.repos)
  if (!repoOf) {
    repoOf = createHostScopedRepoOf(state.repos, getIndexedRepoMap(state.repos))
    repoReaders.set(state.repos, repoOf)
  }
  return selectWorktreeCardPrDisplay(state, worktree, repoOf(worktree))
}
function hiddenStates(state: AppState, source: WorktreeLineageSource): PrStates {
  if (isLineageRange(source)) {
    const { tree } = source
    const inputs = reviewInputs(state)
    const cached = treeStates.get(tree)
    if (cached && inputs.every((value, index) => value === cached.inputs[index])) {
      return cached.states[source.index]!
    }
    const own = tree.identities.map((identity, index) =>
      ownReview(state, worktreeForIdentity(state, identity) ?? tree.worktrees[index]!)
    )
    const states = own.map(emptyStates)
    for (let i = own.length - 1; i >= 0; i--) {
      const parent = tree.parents[i]!
      if (parent >= 0) {
        add(states[parent]!, own[i]!)
        for (const key of STATE_ORDER) {
          merge(states[parent]![key], states[i]![key])
        }
      }
    }
    treeStates.set(tree, { inputs, states })
    return states[source.index]!
  }
  const states = emptyStates()
  for (const identity of lineageIdentities(source)) {
    const worktree = worktreeForIdentity(state, identity)
    if (worktree) {
      add(states, ownReview(state, worktree))
    }
  }
  return states
}
function stateLabel(state: HostedReviewState, count: number): string {
  switch (state) {
    case 'open':
      return translate('sidebar.cardSlot.prOpen', '{{count}} open', { count })
    case 'draft':
      return translate('sidebar.cardSlot.prDraft', '{{count}} draft', { count })
    case 'merged':
      return translate('sidebar.cardSlot.prMerged', '{{count}} merged', { count })
    case 'closed':
      return translate('sidebar.cardSlot.prClosed', '{{count}} closed', { count })
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
  const select = useMemo(() => {
    let inputs: readonly unknown[] = []
    let result = emptyStates()
    return (state: AppState) => {
      const next = reviewInputs(state)
      if (!next.every((value, index) => value === inputs[index])) {
        inputs = next
        result = hiddenStates(state, hiddenDescendants)
      }
      return result
    }
  }, [hiddenDescendants])
  const hidden = useAppStore(useShallow(select))
  const [reviews, setReviews] = useState<ReviewTarget[]>([])
  const states: PrStates = {
    open: { ...hidden.open },
    draft: { ...hidden.draft },
    merged: { ...hidden.merged },
    closed: { ...hidden.closed }
  }
  const hasHidden = STATE_ORDER.some((key) => hidden[key].count > 0)
  const showOwn = !ownRepresentsDescendant || !hasHidden
  if (showOwn) {
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
          title={stateLabel(state, states[state].count)}
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
      {showOwn && own && !own.state ? (
        <ReviewIcon review={own} className="size-3 shrink-0" />
      ) : null}
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
          aria-label={translate('workspace.links.openItem', 'Open {{label}}', {
            label: translate('workspace.links.reviews', 'Reviews')
          })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {icons}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent onClick={(event) => event.stopPropagation()} align="end">
        {showOwn && own ? (
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
