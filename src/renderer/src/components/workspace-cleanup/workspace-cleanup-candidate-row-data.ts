import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupGitLabel,
  hasWorkspaceCleanupLocalContext,
  type WorkspaceCleanupReviewInfo
} from './workspace-cleanup-presentation'
import {
  formatUnpushedCommitCount,
  formatWorkspaceCleanupContextCount,
  formatWorkspaceCleanupContextDetail,
  formatWorkspaceCleanupGitStatusLabel,
  getGitStatusUnknownLabel,
  getNoUnpushedCommitsLabel,
  getUncommittedChangesLabel,
  getUnpushedCommitsLabel,
  getWorkspaceCleanupBlockerLabel
} from './workspace-cleanup-candidate-labels'

export type StatusPillTone = 'neutral' | 'ready' | 'review' | 'destructive'

export function getWorkspaceCleanupBlockerLabels(candidate: WorkspaceCleanupCandidate): string[] {
  return candidate.blockers.map((blocker) => getWorkspaceCleanupBlockerLabel(blocker))
}

export function getCandidateStatus(candidate: WorkspaceCleanupCandidate): {
  label: string
  tone: StatusPillTone
} {
  if (candidate.blockers.includes('dismissed')) {
    return {
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e8b3741ff7',
        'Ignored'
      ),
      tone: 'neutral'
    }
  }
  if (candidate.tier === 'ready') {
    return {
      label: candidate.reasons.includes('archived')
        ? translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.archivedStatus',
            'Archived'
          )
        : translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.readyStatus',
            'Ready'
          ),
      tone: 'ready'
    }
  }
  if (candidate.blockers.length > 0) {
    return { label: getWorkspaceCleanupBlockerLabel(candidate.blockers[0]), tone: 'neutral' }
  }
  if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
    return {
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.9623a5107d',
        'Unpushed commits'
      ),
      tone: 'review'
    }
  }
  if (candidate.git.clean === false) {
    return {
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e97e4580c7',
        'Dirty'
      ),
      tone: 'review'
    }
  }
  if (candidate.tier === 'review') {
    return {
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.0a2e3c7cba',
        'Review'
      ),
      tone: 'review'
    }
  }
  return {
    label: translate(
      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.c4f4782c02',
      'Not suggested'
    ),
    tone: 'neutral'
  }
}

export function formatGitStatus(candidate: WorkspaceCleanupCandidate): string {
  return formatWorkspaceCleanupGitStatusLabel(getWorkspaceCleanupGitLabel(candidate))
}

export function formatBranchSafetyDetails(candidate: WorkspaceCleanupCandidate): string[] {
  const details: string[] = []
  if (candidate.git.upstreamAhead !== null) {
    details.push(
      candidate.git.upstreamAhead === 0
        ? getNoUnpushedCommitsLabel()
        : formatUnpushedCommitCount(candidate.git.upstreamAhead)
    )
  }
  return details
}

export function formatContextDetails(candidate: WorkspaceCleanupCandidate): string | null {
  const parts: string[] = []
  if (candidate.localContext.terminalTabCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('terminal', candidate.localContext.terminalTabCount)
    )
  }
  if (candidate.localContext.cleanEditorTabCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('editor', candidate.localContext.cleanEditorTabCount)
    )
  }
  if (candidate.localContext.browserTabCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('browser', candidate.localContext.browserTabCount)
    )
  }
  if (candidate.localContext.diffCommentCount > 0) {
    parts.push(formatWorkspaceCleanupContextDetail('diff', candidate.localContext.diffCommentCount))
  }
  if (candidate.localContext.retainedDoneAgentCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('agent', candidate.localContext.retainedDoneAgentCount)
    )
  }
  return parts.length > 0 ? parts.join(', ') : null
}

export function getDirtyGitLabel(candidate: WorkspaceCleanupCandidate): string | null {
  if (
    candidate.blockers.includes('unknown-base') ||
    candidate.blockers.includes('git-status-error')
  ) {
    return null
  }
  if (candidate.blockers.includes('unpushed-commits')) {
    if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
      return formatUnpushedCommitCount(candidate.git.upstreamAhead)
    }
    return getUnpushedCommitsLabel()
  }
  if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
    return formatUnpushedCommitCount(candidate.git.upstreamAhead)
  }
  if (candidate.git.clean === false) {
    return getUncommittedChangesLabel()
  }
  if (candidate.git.clean == null) {
    return getGitStatusUnknownLabel()
  }
  return null
}

export function shouldShowGitMetadataChip(candidate: WorkspaceCleanupCandidate): boolean {
  return (
    !candidate.blockers.includes('unknown-base') &&
    !candidate.blockers.includes('git-status-error') &&
    !hasGitStatusPill(candidate)
  )
}

function hasGitStatusPill(candidate: WorkspaceCleanupCandidate): boolean {
  if (
    candidate.blockers.includes('dirty-files') ||
    candidate.blockers.includes('unpushed-commits')
  ) {
    return true
  }
  if (candidate.blockers.length > 0 || candidate.tier === 'ready') {
    return false
  }
  return (candidate.git.upstreamAhead ?? 0) > 0 || candidate.git.clean === false
}

export function getReviewPillTone(reviewInfo: WorkspaceCleanupReviewInfo): StatusPillTone {
  if (reviewInfo.state === 'open' || reviewInfo.state === 'draft') {
    return 'review'
  }
  return 'neutral'
}

export function getContextPillLabel(candidate: WorkspaceCleanupCandidate): string | null {
  if (!hasWorkspaceCleanupLocalContext(candidate)) {
    return null
  }
  return formatWorkspaceCleanupContextCount(getContextCount(candidate))
}

export function getContextCount(candidate: WorkspaceCleanupCandidate): number {
  return (
    candidate.localContext.terminalTabCount +
    candidate.localContext.cleanEditorTabCount +
    candidate.localContext.browserTabCount +
    candidate.localContext.diffCommentCount +
    candidate.localContext.retainedDoneAgentCount
  )
}
