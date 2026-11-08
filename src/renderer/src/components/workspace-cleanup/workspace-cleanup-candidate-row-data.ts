import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupGitState } from './workspace-cleanup-presentation'
import {
  formatUnpushedCommitCount,
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

type CandidateFactStatus = {
  label: string
  tone: StatusPillTone
  /** Git safety verdict; the row renders these as pills and everything else as muted flags. */
  git: boolean
}

export function getCandidateFactStatuses(
  candidate: WorkspaceCleanupCandidate,
  t: Translate = translate
): CandidateFactStatus[] {
  if (candidate.blockers.length > 0) {
    return candidate.blockers.map(getBlockerFactStatus)
  }
  if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
    return [
      {
        label: t(
          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.9623a5107d',
          'Unpushed commits'
        ),
        tone: 'review',
        git: true
      }
    ]
  }
  if (candidate.git.clean === false) {
    return [
      {
        label: t('auto.components.workspace.cleanup.WorkspaceCleanupDialog.e97e4580c7', 'Dirty'),
        tone: 'review',
        git: true
      }
    ]
  }
  if (candidate.reasons.includes('archived')) {
    return [
      {
        label: t(
          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.archivedStatus',
          'Archived'
        ),
        tone: 'neutral',
        git: false
      }
    ]
  }
  return []
}

const GIT_SAFETY_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> = new Set([
  'dirty-files',
  'unpushed-commits',
  'unknown-base',
  'git-status-error'
])

function getBlockerFactStatus(blocker: WorkspaceCleanupBlocker): CandidateFactStatus {
  return {
    label:
      blocker === 'dismissed'
        ? translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e8b3741ff7',
            'Ignored'
          )
        : getWorkspaceCleanupBlockerLabel(blocker),
    tone:
      blocker === 'git-status-error' || blocker === 'unknown-base'
        ? 'destructive'
        : blocker === 'dirty-files' || blocker === 'unpushed-commits'
          ? 'review'
          : 'neutral',
    git: GIT_SAFETY_BLOCKERS.has(blocker)
  }
}

export function formatGitStatus(candidate: WorkspaceCleanupCandidate, t?: Translate): string {
  return formatWorkspaceCleanupGitStatusLabel(getWorkspaceCleanupGitState(candidate), t)
}

export function formatBranchSafetyDetails(
  candidate: WorkspaceCleanupCandidate,
  t?: Translate
): string[] {
  const details: string[] = []
  if (candidate.git.upstreamAhead !== null) {
    details.push(
      candidate.git.upstreamAhead === 0
        ? getNoUnpushedCommitsLabel(t)
        : formatUnpushedCommitCount(candidate.git.upstreamAhead, t)
    )
  }
  return details
}

export function formatContextDetailLabels(
  candidate: WorkspaceCleanupCandidate,
  t?: Translate
): string[] {
  const parts: string[] = []
  if (candidate.localContext.terminalTabCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('terminal', candidate.localContext.terminalTabCount, t)
    )
  }
  if (candidate.localContext.cleanEditorTabCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('editor', candidate.localContext.cleanEditorTabCount, t)
    )
  }
  if (candidate.localContext.browserTabCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('browser', candidate.localContext.browserTabCount, t)
    )
  }
  if (candidate.localContext.diffCommentCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('diff', candidate.localContext.diffCommentCount, t)
    )
  }
  if (candidate.localContext.retainedDoneAgentCount > 0) {
    parts.push(
      formatWorkspaceCleanupContextDetail('agent', candidate.localContext.retainedDoneAgentCount, t)
    )
  }
  return parts
}

export function formatContextDetails(
  candidate: WorkspaceCleanupCandidate,
  t?: Translate
): string | null {
  const parts = formatContextDetailLabels(candidate, t)
  return parts.length > 0 ? parts.join(', ') : null
}

export function getDirtyGitLabel(
  candidate: WorkspaceCleanupCandidate,
  t: Translate = translate
): string | null {
  if (candidate.blockers.includes('git-status-error')) {
    return t('components.workspace.cleanup.browse.gitStatusCheckFailed', 'Git status check failed')
  }
  if (candidate.blockers.includes('unknown-base')) {
    return t(
      'components.workspace.cleanup.browse.gitStatusUnverified',
      'Git status could not be verified'
    )
  }
  if (candidate.blockers.includes('unpushed-commits')) {
    if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
      return formatUnpushedCommitCount(candidate.git.upstreamAhead, t)
    }
    return getUnpushedCommitsLabel(t)
  }
  if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
    return formatUnpushedCommitCount(candidate.git.upstreamAhead, t)
  }
  if (candidate.git.clean === false) {
    return getUncommittedChangesLabel(t)
  }
  if (candidate.git.clean == null) {
    return getGitStatusUnknownLabel(t)
  }
  return null
}

export function shouldShowGitMetadataChip(
  candidate: WorkspaceCleanupCandidate,
  t?: Translate
): boolean {
  return !getCandidateFactStatuses(candidate, t).some((status) => status.git)
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
