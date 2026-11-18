import type { Translate } from '@/i18n/use-translate'
import type { WorktreeCardPrDisplay } from '../../sidebar/workspace-card/review/worktree-card-pr-display'

/** Where a conversation's PR stands, most actionable reading first. */
export type ZotzPrStatusKind =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'conflicts'
  | 'failing'
  | 'pending'
  | 'ready'
  | 'open'

export type ZotzPrTone = 'success' | 'danger' | 'muted' | 'merged'

export function zotzPrStatus(pr: WorktreeCardPrDisplay): ZotzPrStatusKind {
  if (pr.state === 'merged') {
    return 'merged'
  }
  if (pr.state === 'closed') {
    return 'closed'
  }
  if ('mergeable' in pr && pr.mergeable === 'CONFLICTING') {
    return 'conflicts'
  }
  if (pr.status === 'failure') {
    return 'failing'
  }
  if (pr.state === 'draft') {
    return 'draft'
  }
  if (pr.status === 'pending') {
    return 'pending'
  }
  return pr.status === 'success' || pr.status === 'neutral' ? 'ready' : 'open'
}

export function zotzPrTone(kind: ZotzPrStatusKind): ZotzPrTone {
  switch (kind) {
    case 'ready':
      return 'success'
    case 'conflicts':
    case 'failing':
      return 'danger'
    case 'merged':
      return 'merged'
    case 'closed':
    case 'draft':
    case 'open':
    case 'pending':
      return 'muted'
  }
}

export const ZOTZ_PR_TONE_TEXT: Record<ZotzPrTone, string> = {
  success: 'text-status-success',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
  merged: 'text-foreground'
}

export function zotzPrStatusLabel(kind: ZotzPrStatusKind, t: Translate): string {
  switch (kind) {
    case 'merged':
      return t('zotz.pr.merged', 'Merged')
    case 'closed':
      return t('zotz.pr.closed', 'Closed')
    case 'draft':
      return t('zotz.pr.draft', 'Draft')
    case 'conflicts':
      return t('zotz.pr.conflicts', 'Merge conflicts')
    case 'failing':
      return t('zotz.pr.failing', 'Checks failed')
    case 'pending':
      return t('zotz.pr.pending', 'Checks running…')
    case 'ready':
      return t('zotz.pr.ready', 'Ready to merge')
    case 'open':
      return t('zotz.pr.open', 'Open')
  }
}
