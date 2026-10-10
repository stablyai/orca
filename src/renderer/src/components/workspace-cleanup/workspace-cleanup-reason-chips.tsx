import React from 'react'
import { Bot, FolderX, GitMerge, Unlink, type LucideIcon } from 'lucide-react'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'
import { WorkspaceCleanupMetadataChip } from './workspace-cleanup-metadata-chip'
import {
  getWorkspaceCleanupReasonChips,
  type WorkspaceCleanupChipReason
} from './workspace-cleanup-reason-labels'

const REASON_ICONS: Record<WorkspaceCleanupChipReason, LucideIcon> = {
  merged: GitMerge,
  'stale-agent': Bot,
  prunable: Unlink,
  unregistered: FolderX
}

/** Neutral on purpose: a reason suggests cleanup, while blockers alone decide what is safe. */
export function WorkspaceCleanupReasonChips({
  candidate,
  reviewInfo
}: {
  candidate: Pick<WorkspaceCleanupCandidate, 'reasons' | 'mergedBaseRef'>
  reviewInfo?: Pick<WorkspaceCleanupReviewInfo, 'state'>
}): React.JSX.Element {
  return (
    <>
      {getWorkspaceCleanupReasonChips(candidate, reviewInfo).map((chip) => (
        <WorkspaceCleanupMetadataChip
          key={chip.reason}
          icon={REASON_ICONS[chip.reason]}
          label={chip.description}
          value={chip.label}
        />
      ))}
    </>
  )
}
