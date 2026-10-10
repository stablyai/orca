import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'

/** Reasons the row shows as chips; archived has its own status pill and idle shows as age. */
export type WorkspaceCleanupChipReason = 'merged' | 'stale-agent' | 'prunable' | 'unregistered'

export type WorkspaceCleanupReasonChip = {
  reason: WorkspaceCleanupChipReason
  label: string
  description: string
}

const CHIP_REASON_ORDER: readonly WorkspaceCleanupChipReason[] = [
  'merged',
  'stale-agent',
  'prunable',
  'unregistered'
]

/** Null for reasons without a chip, including any a newer host sends that this build does not know. */
export function getWorkspaceCleanupReasonLabel(reason: string): string | null {
  switch (reason) {
    case 'merged':
      return translate('components.workspace.cleanup.reason.merged', 'Merged')
    case 'stale-agent':
      return translate('components.workspace.cleanup.reason.staleAgent', 'Stale agent')
    case 'prunable':
      return translate('components.workspace.cleanup.reason.prunable', 'Prunable')
    case 'unregistered':
      return translate('components.workspace.cleanup.reason.unregistered', 'Unregistered')
    default:
      return null
  }
}

/**
 * Provider review state is reused for `merged` so squash and rebase merges, which ancestry cannot
 * see, still read as merged. It labels the row only; the host's safety tiers never read it.
 */
export function getWorkspaceCleanupReasonChips(
  candidate: Pick<WorkspaceCleanupCandidate, 'reasons' | 'mergedBaseRef'>,
  review?: Pick<WorkspaceCleanupReviewInfo, 'state'>
): WorkspaceCleanupReasonChip[] {
  const reasons = new Set<string>(candidate.reasons)
  const reviewMerged = review?.state === 'merged'
  const chips: WorkspaceCleanupReasonChip[] = []
  for (const reason of CHIP_REASON_ORDER) {
    const shown = reason === 'merged' ? reasons.has(reason) || reviewMerged : reasons.has(reason)
    const label = shown ? getWorkspaceCleanupReasonLabel(reason) : null
    if (label) {
      chips.push({ reason, label, description: describeReason(reason, candidate) })
    }
  }
  return chips
}

function describeReason(
  reason: WorkspaceCleanupChipReason,
  candidate: Pick<WorkspaceCleanupCandidate, 'reasons' | 'mergedBaseRef'>
): string {
  switch (reason) {
    case 'merged':
      // The review chip beside it already names the PR or MR.
      if (!candidate.reasons.includes('merged')) {
        return translate(
          'components.workspace.cleanup.reason.reviewMerged',
          'Its linked review was merged'
        )
      }
      return candidate.mergedBaseRef
        ? translate(
            'components.workspace.cleanup.reason.mergedInto',
            'All branch commits are in {{value0}}',
            { value0: candidate.mergedBaseRef }
          )
        : translate(
            'components.workspace.cleanup.reason.mergedIntoBase',
            'All branch commits are in the base branch'
          )
    case 'stale-agent':
      return translate(
        'components.workspace.cleanup.reason.staleAgentDescription',
        'Coding-agent scratch worktree, idle 7+ days, no live agent reported'
      )
    case 'prunable':
      return translate(
        'components.workspace.cleanup.reason.prunableDescription',
        'Git still lists this worktree, but its folder or Git link is gone'
      )
    case 'unregistered':
      return translate(
        'components.workspace.cleanup.reason.unregisteredDescription',
        'No project registers this folder as a worktree'
      )
  }
}
