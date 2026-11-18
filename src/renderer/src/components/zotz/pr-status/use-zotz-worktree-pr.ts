import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  deriveWorktreeCardPrDisplay,
  getWorktreeReviewCacheKeys
} from '../../sidebar/workspace-card/review/worktree-card-pr-derivation'
import type { WorktreeCardPrDisplay } from '../../sidebar/workspace-card/review/worktree-card-pr-display'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { zotzPrStatus, type ZotzPrStatusKind } from './zotz-pr-status'

export type ZotzWorktreePr = {
  pr: WorktreeCardPrDisplay
  /** The GitHub read, when there is one: merge methods and the PR's own repo live here. */
  githubPR: PRInfo | null
  status: ZotzPrStatusKind
}

/** The worktree's PR from the same caches upstream's cards read; null without one. */
export function useZotzWorktreePr(
  worktree: Worktree | null,
  repo: Repo | undefined
): ZotzWorktreePr | null {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
  const keys = worktree ? getWorktreeReviewCacheKeys(worktree, repo, settings) : null
  const hostedReviewEntry = useAppStore((s) =>
    keys?.hostedReviewCacheKey ? s.hostedReviewCache[keys.hostedReviewCacheKey] : undefined
  )
  const prCacheEntry = useAppStore((s) =>
    keys?.prCacheKey ? s.prCache?.[keys.prCacheKey] : undefined
  )
  if (!worktree) {
    return null
  }
  const { prDisplay } = deriveWorktreeCardPrDisplay(worktree, hostedReviewEntry, prCacheEntry, t)
  if (!prDisplay) {
    return null
  }
  return { pr: prDisplay, githubPR: prCacheEntry?.data ?? null, status: zotzPrStatus(prDisplay) }
}
