import {
  CalendarClock,
  Clock,
  GitCommitHorizontal,
  GitMerge,
  Network,
  type LucideIcon
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { getReviewStateTone } from '@/components/github/review-state-presentation'
import { WorkspaceCleanupMetadataChip } from '@/components/workspace-cleanup/candidate-list/workspace-cleanup-metadata-chip'
import type { WorkspaceCleanupRuleReason } from '../../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { formatCleanupRuleReasonBadge } from './workspace-cleanup-run-labels'

const REASON_ICONS: Record<WorkspaceCleanupRuleReason, LucideIcon> = {
  merged: GitMerge,
  unchanged: GitCommitHorizontal,
  inactive: Clock,
  'automation-run': CalendarClock,
  'orchestration-worker': Network
}

/** The rule that removes, or would remove, a workspace. */
export function WorkspaceCleanupReasonChip({
  reason,
  prNumber
}: {
  reason: WorkspaceCleanupRuleReason
  /** The merged pull request, when the host read one. */
  prNumber?: number
}): React.JSX.Element {
  const t = useTranslate()
  const badge = formatCleanupRuleReasonBadge(reason, t)
  const label =
    reason === 'merged' && prNumber !== undefined
      ? t('components.settings.workspaceCleanup.reason.mergedNumber', '{{label}} · #{{number}}', {
          label: badge,
          number: prNumber
        })
      : badge
  return (
    <WorkspaceCleanupMetadataChip
      icon={REASON_ICONS[reason] ?? Clock}
      label={label}
      value={label}
      toneClassName={reason === 'merged' ? getReviewStateTone('merged') : undefined}
    />
  )
}
