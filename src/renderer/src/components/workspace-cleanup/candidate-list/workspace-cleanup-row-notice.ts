import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import {
  formatUnpushedCommitCount,
  formatWorkspaceCleanupIgnoredFilesLabel,
  getUncommittedChangesLabel,
  getUnpushedCommitsLabel
} from './workspace-cleanup-candidate-labels'
import { getWorkspaceCleanupCandidateHostLabel } from './workspace-cleanup-host-label'

export type WorkspaceCleanupRowNotice = {
  /** Warning for local files at risk; plain for why a row cannot be deleted. */
  tone: 'warning' | 'plain'
  text: string
}

function getCannotDeleteText(candidate: WorkspaceCleanupCandidate, t: Translate): string {
  if (candidate.blockers.includes('folder-repo')) {
    return t(
      'components.workspace.cleanup.row.notGit',
      'Not a git workspace. Remove the project from Orca instead.'
    )
  }
  if (candidate.blockers.includes('ssh-disconnected')) {
    return t(
      'components.workspace.cleanup.row.unreachable',
      "Can't reach {{host}}. Reconnect to delete, or remove it from Orca.",
      { host: getWorkspaceCleanupCandidateHostLabel(candidate, t) }
    )
  }
  return t(
    'components.workspace.cleanup.row.mainCheckout',
    "Can't delete the project's main checkout."
  )
}

function getLocalFileParts(candidate: WorkspaceCleanupCandidate, t: Translate): string[] {
  const parts: string[] = []
  const blockers = candidate.blockers
  const { git } = candidate
  const gitUnreadable =
    blockers.includes('git-status-error') ||
    blockers.includes('unknown-base') ||
    git.checkedAt === null
  if (blockers.includes('dirty-files') || git.clean === false) {
    parts.push(
      git.dirtyFileCount
        ? t('components.workspace.cleanup.row.uncommittedFiles', '{{count}} uncommitted files', {
            count: git.dirtyFileCount,
            defaultValue_one: '{{count}} uncommitted file'
          })
        : getUncommittedChangesLabel(t)
    )
  }
  if (blockers.includes('ignored-files')) {
    parts.push(formatWorkspaceCleanupIgnoredFilesLabel(git.atRiskLocalFiles, t))
  }
  if (blockers.includes('unpushed-commits')) {
    parts.push(
      git.upstreamAhead && git.upstreamAhead > 0
        ? formatUnpushedCommitCount(git.upstreamAhead, t)
        : getUnpushedCommitsLabel(t)
    )
  }
  if (gitUnreadable) {
    parts.push(t('components.workspace.cleanup.row.couldntCheck', "Couldn't check for changes"))
  }
  return parts
}

/** The row's one optional second line; null when nothing needs saying. */
export function getWorkspaceCleanupRowNotice(
  candidate: WorkspaceCleanupCandidate,
  group: WorkspaceCleanupGroup,
  t: Translate = translate
): WorkspaceCleanupRowNotice | null {
  if (group === 'cannot-delete') {
    return { tone: 'plain', text: getCannotDeleteText(candidate, t) }
  }
  const parts = getLocalFileParts(candidate, t)
  return parts.length > 0 ? { tone: 'warning', text: parts.join(' · ') } : null
}
