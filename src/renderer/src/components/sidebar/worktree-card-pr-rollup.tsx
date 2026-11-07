import React, { createElement, useCallback } from 'react'
import { getReviewStateIcon } from '@/components/github/review-state-presentation'
import { cn } from '@/lib/utils'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import type { HostedReviewState } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { selectWorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-derivation'
import type { WorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-display'
import { getReviewStateTone } from './workspace-card/review/worktree-review-presentation'
import { PullRequestIcon } from './workspace-card/identity/worktree-card-glyphs'
import { splitIdentities, worktreeForIdentity } from './worktree-card-slot-rollup'

/** Most actionable first; every state with a PR gets its own icon so mixed states are never merged. */
const STATE_ORDER: readonly HostedReviewState[] = ['open', 'draft', 'merged', 'closed']

type PrStateCounts = Record<HostedReviewState, number>

const NO_COUNTS: PrStateCounts = { open: 0, draft: 0, merged: 0, closed: 0 }

function selectHiddenPrCounts(state: AppState, descendantKey: string): PrStateCounts {
  if (!descendantKey) {
    return NO_COUNTS
  }
  const counts = { ...NO_COUNTS }
  for (const identity of splitIdentities(descendantKey)) {
    const worktree = worktreeForIdentity(state, identity)
    if (!worktree) {
      continue
    }
    const repo = getIndexedRepoMap(state.repos).get(worktree.repoId)
    const review = selectWorktreeCardPrDisplay(state, worktree, repo)
    if (review?.state) {
      counts[review.state] += 1
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
  hiddenDescendants: readonly HostScopedWorktreeKey[]
}): React.JSX.Element | null {
  const descendantKey = hiddenDescendants.join('\n')
  const hidden = useAppStore(
    useShallow(
      useCallback((state: AppState) => selectHiddenPrCounts(state, descendantKey), [descendantKey])
    )
  )
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
