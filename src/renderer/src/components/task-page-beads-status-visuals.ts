import {
  CheckCircle2,
  CircleDot,
  CircleDotDashed,
  CirclePause,
  CircleSlash,
  type LucideIcon
} from 'lucide-react'

import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { BeadsIssueStatus } from '../../../shared/beads-types'

export const BEADS_STATUS_ORDER: readonly BeadsIssueStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'closed'
]

export const getBeadsStatusLabels = createLocalizedCatalog(
  (): Record<BeadsIssueStatus, string> => ({
    open: translate('auto.components.TaskPage.606a85c774', 'Open'),
    in_progress: translate('auto.components.TaskPage.beadsStatusInProgress', 'In Progress'),
    blocked: translate('auto.components.TaskPage.beadsStatusBlocked', 'Blocked'),
    deferred: translate('auto.components.TaskPage.beadsStatusDeferred', 'Deferred'),
    closed: translate('auto.components.TaskPage.d09bf34db7', 'Closed')
  })
)

// Why: the list Status column keeps GitHub's 100px width — 'In Progress' wraps there,
// so the pill uses abbreviated labels while dropdowns and the detail view stay full.
export const getBeadsStatusShortLabels = createLocalizedCatalog(
  (): Record<BeadsIssueStatus, string> => ({
    open: translate('auto.components.TaskPage.606a85c774', 'Open'),
    in_progress: translate('auto.components.TaskPage.beadsStatusInProgressShort', 'In Prog.'),
    blocked: translate('auto.components.TaskPage.beadsStatusBlocked', 'Blocked'),
    deferred: translate('auto.components.TaskPage.beadsStatusDeferred', 'Deferred'),
    closed: translate('auto.components.TaskPage.d09bf34db7', 'Closed')
  })
)

// Why: reuse existing state tones — GitHub's open/closed pill colors, Jira's
// in-flight blue, destructive for blocked, muted for deferred. No new colors.
export function getBeadsStatusTone(status: BeadsIssueStatus): string {
  switch (status) {
    case 'open':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
    case 'in_progress':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
    case 'blocked':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    case 'deferred':
      return 'border-border/50 bg-muted/40 text-muted-foreground'
    case 'closed':
      return 'border-primary/40 bg-primary/10 text-primary'
  }
}

// Why: the detail page's meta-band chip is solid and borderless like GitHubItemDialog's
// issue badge (open emerald-600, closed rose-600); the soft tints stay on list pills.
export function getBeadsStatusDetailTone(status: BeadsIssueStatus): string {
  switch (status) {
    case 'open':
      return 'bg-emerald-600 text-white'
    case 'in_progress':
      return 'bg-sky-600 text-white'
    case 'blocked':
      return 'bg-destructive text-white'
    case 'deferred':
      return 'bg-slate-500 text-white'
    case 'closed':
      return 'bg-rose-600 text-white'
  }
}

export const BEADS_STATUS_ICONS: Record<BeadsIssueStatus, LucideIcon> = {
  open: CircleDot,
  in_progress: CircleDotDashed,
  blocked: CircleSlash,
  deferred: CirclePause,
  closed: CheckCircle2
}
