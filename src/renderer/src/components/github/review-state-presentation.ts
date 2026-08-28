import { GitMerge, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react'
import type { HostedReviewState } from '../../../../shared/hosted-review'

/** Every review surface renders state from here; `unknown` means we have a number but no fetched state. */
export type ReviewStateForDisplay = HostedReviewState | 'unknown' | null | undefined

/** Also the tone for an open issue, which reads the same as an open review. */
export const OPEN_REVIEW_STATE_TONE =
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'

/** Outline-pill tone: purple merged, rose closed, slate draft, emerald open, neutral unknown. */
export function getReviewStateTone(state: ReviewStateForDisplay): string {
  if (state === 'merged') {
    return 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300'
  }
  if (state === 'draft') {
    return 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
  }
  if (state === 'closed') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
  }
  if (state === 'open') {
    return OPEN_REVIEW_STATE_TONE
  }
  return 'border-border bg-background text-muted-foreground'
}

// Why: the glyph must carry review state — tone alone made a draft with failing
// checks render as a red PR icon, which reads as closed.
export function getReviewStateIcon(state: ReviewStateForDisplay): LucideIcon | null {
  if (state === 'merged') {
    return GitMerge
  }
  if (state === 'closed') {
    return GitPullRequestClosed
  }
  if (state === 'draft') {
    return GitPullRequestDraft
  }
  return null
}
