import { getWorktreeCardPrDisplay } from '@/components/sidebar/worktree-card-pr-display'
import type { HostedReviewInfo, HostedReviewState } from '../../../shared/hosted-review'
import type { Worktree } from '../../../shared/types'

// Why: Mission Control rows reuse the worktree card's PR-display derivation so a
// worker's pull request reads identically wherever it appears. This maps that
// display down to the compact badge the panel renders (provider label + number +
// state + url). Pure — the component supplies the cached review from the store.

export type WorkerPrBadge = {
  label: 'PR' | 'MR'
  number: number
  state?: HostedReviewState
  url?: string
}

type LinkedReviewWorktree = Pick<
  Worktree,
  'linkedPR' | 'linkedGitLabMR' | 'linkedBitbucketPR' | 'linkedAzureDevOpsPR' | 'linkedGiteaPR'
>

export function deriveWorkerPrBadge(
  worktree: LinkedReviewWorktree,
  review: HostedReviewInfo | null | undefined,
  reviewHintKey?: string
): WorkerPrBadge | null {
  const display = getWorktreeCardPrDisplay(
    review,
    worktree.linkedPR ?? null,
    worktree.linkedGitLabMR ?? null,
    worktree.linkedBitbucketPR ?? null,
    worktree.linkedAzureDevOpsPR ?? null,
    worktree.linkedGiteaPR ?? null,
    { reviewHintKey }
  )
  if (!display || display.provider === 'unsupported') {
    return null
  }
  return {
    label: display.provider === 'gitlab' ? 'MR' : 'PR',
    number: display.number,
    state: display.state,
    url: display.url
  }
}
