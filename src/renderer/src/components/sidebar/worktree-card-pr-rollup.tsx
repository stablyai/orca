import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { createHostScopedRepoOf } from '../../../../shared/sidebar-list/sidebar-feed-index'
import React, { createElement, useMemo } from 'react'
import { getReviewStateIcon } from '@/components/github/review-state-presentation'
import { cn } from '@/lib/utils'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  isLineageRange,
  lineageIdentities,
  type WorktreeLineageSource,
  type WorktreeLineageTree
} from '../../../../shared/sidebar-list/worktree-lineage-range'
import type { HostedReviewState } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { selectWorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-derivation'
import type { WorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-display'
import { getReviewStateTone } from './workspace-card/review/worktree-review-presentation'
import { PullRequestIcon } from './workspace-card/identity/worktree-card-glyphs'
import { worktreeForIdentity } from './worktree-card-slot-rollup'

/** Most actionable first; every state with a PR gets its own icon so mixed states are never merged. */
const STATE_ORDER: readonly HostedReviewState[] = ['open', 'draft', 'merged', 'closed']

type PrStateCounts = Record<HostedReviewState, number>

const NO_COUNTS: PrStateCounts = { open: 0, draft: 0, merged: 0, closed: 0 }

const treeCounts = new WeakMap<
  WorktreeLineageTree,
  { inputs: readonly unknown[]; counts: PrStateCounts[] }
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
function ownPrCounts(
  state: AppState,
  worktree: NonNullable<ReturnType<typeof worktreeForIdentity>>
): PrStateCounts {
  let repoOf = repoReaders.get(state.repos)
  if (!repoOf) {
    repoOf = createHostScopedRepoOf(state.repos, getIndexedRepoMap(state.repos))
    repoReaders.set(state.repos, repoOf)
  }
  const repo = repoOf(worktree)
  const review = selectWorktreeCardPrDisplay(state, worktree, repo)
  return { ...NO_COUNTS, ...(review?.state ? { [review.state]: 1 } : {}) }
}
function selectHiddenPrCounts(state: AppState, source: WorktreeLineageSource): PrStateCounts {
  if (isLineageRange(source)) {
    const { tree } = source
    const inputs = reviewInputs(state)
    const cached = treeCounts.get(tree)
    if (cached && inputs.every((value, index) => value === cached.inputs[index])) {
      return cached.counts[source.index]!
    }
    const own = tree.identities.map((identity, index) =>
      ownPrCounts(state, worktreeForIdentity(state, identity) ?? tree.worktrees[index]!)
    )
    const counts = own.map(() => ({ ...NO_COUNTS }))
    for (let i = own.length - 1; i >= 0; i--) {
      const parent = tree.parents[i]!
      if (parent >= 0) {
        for (const key of STATE_ORDER) {
          counts[parent]![key] += own[i]![key] + counts[i]![key]
        }
      }
    }
    treeCounts.set(tree, { inputs, counts })
    return counts[source.index]!
  }
  const counts = { ...NO_COUNTS }
  for (const identity of lineageIdentities(source)) {
    const worktree = worktreeForIdentity(state, identity)
    if (worktree) {
      const own = ownPrCounts(state, worktree)
      for (const key of STATE_ORDER) {
        counts[key] += own[key]
      }
    }
  }
  return counts
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

/**
 * The card's own PR plus those of hidden child workspaces, one icon per state with its count
 * on the icon's corner, so a collapsed parent still says what its subtree has in review.
 */
export function WorktreeCardPrRollup({
  own,
  hiddenDescendants
}: {
  own: WorktreeCardPrDisplay | null
  hiddenDescendants: WorktreeLineageSource
}): React.JSX.Element | null {
  const select = useMemo(() => {
    let inputs: readonly unknown[] = []
    let counts = NO_COUNTS
    return (state: AppState) => {
      const next = reviewInputs(state)
      if (next.every((value, index) => value === inputs[index])) {
        return counts
      }
      inputs = next
      counts = selectHiddenPrCounts(state, hiddenDescendants)
      return counts
    }
  }, [hiddenDescendants])
  const hidden = useAppStore(useShallow(select))
  const counts = { ...hidden }
  if (own?.state) {
    counts[own.state] += 1
  }
  const shown = STATE_ORDER.filter((state) => counts[state] > 0)
  if (shown.length === 0) {
    return null
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-worktree-card-prs="">
      {shown.map((state) => (
        <span
          key={state}
          // The tone sits on the wrapper so the corner count can fill with the same color.
          className={cn('worktree-card-pr-state', getReviewStateTone(state))}
          title={stateLabel(state, counts[state])}
          data-pr-state={state}
        >
          {createElement(getReviewStateIcon(state) ?? PullRequestIcon, {
            className: 'size-3 shrink-0'
          })}
          {counts[state] > 1 ? (
            <span className="worktree-card-pr-count" aria-hidden>
              {counts[state]}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  )
}
