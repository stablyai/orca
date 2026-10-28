import { translate } from '@/i18n/i18n'
import type { MultiRepoWorkspaceSummary } from '@/store/slices/multi-repo-workspace/multi-repo-workspace-selectors'
import type { RootPanelRowStatus } from './root-panel-model'

/** "3 repos · 1 with changes", "Creating 2/3", "3 repos · 1 failed": words carry every state. */
export function getRootPanelHeaderText(summary: MultiRepoWorkspaceSummary): string {
  const parts: string[] = []
  const inFlight = summary.creating + summary.queued
  if (inFlight > 0) {
    parts.push(
      translate('auto.components.multiRepo.root.creating', 'Creating {{done}}/{{total}}', {
        done: summary.total - inFlight,
        total: summary.total
      })
    )
  } else {
    parts.push(
      summary.total === 1
        ? translate('auto.components.multiRepo.root.repoOne', '1 repo')
        : translate('auto.components.multiRepo.root.repoMany', '{{n}} repos', { n: summary.total })
    )
  }
  if (summary.failed > 0) {
    parts.push(
      translate('auto.components.multiRepo.root.failed', '{{n}} failed', { n: summary.failed })
    )
  }
  if (summary.interrupted > 0) {
    parts.push(
      translate('auto.components.multiRepo.root.interrupted', '{{n}} interrupted', {
        n: summary.interrupted
      })
    )
  }
  if (summary.missing > 0) {
    parts.push(
      translate('auto.components.multiRepo.root.missing', '{{n}} missing', { n: summary.missing })
    )
  }
  if (summary.withChanges > 0) {
    parts.push(
      translate('auto.components.multiRepo.root.withChanges', '{{n}} with changes', {
        n: summary.withChanges
      })
    )
  }
  return parts.join(' · ')
}

export function getRootPanelStatusText(status: RootPanelRowStatus): string {
  switch (status.kind) {
    case 'queued':
      return translate('auto.components.multiRepo.root.waiting', 'Waiting')
    case 'creating':
      return translate('auto.components.multiRepo.root.creatingRow', 'Creating…')
    case 'interrupted':
      return translate('auto.components.multiRepo.root.interruptedRow', 'Interrupted')
    case 'missing':
      return translate('auto.components.multiRepo.root.missingOnDisk', 'Missing on disk')
    case 'project_removed':
      return translate('auto.components.multiRepo.root.projectRemoved', 'Project removed')
    case 'failed':
      return getFailureSummary(status.code)
    case 'ready':
      // Unknown counts say nothing: "Clean" is claimed only when the status is known and empty.
      if (status.changedCount === null) {
        return ''
      }
      return status.changedCount === 0
        ? translate('auto.components.multiRepo.root.clean', 'Clean')
        : translate('auto.components.multiRepo.root.changed', '{{n}} changed', {
            n: status.changedCount
          })
  }
}

export function getNotCreatedNote(labels: readonly string[]): string {
  return translate(
    'auto.components.multiRepo.root.notCreated',
    '{{names}} not created yet. The workspace folder holds only the ready repos.',
    { names: labels.join(', ') }
  )
}

function getFailureSummary(code: Extract<RootPanelRowStatus, { kind: 'failed' }>['code']): string {
  switch (code) {
    case 'path_occupied':
      return translate('auto.components.multiRepo.root.failedPathOccupied', 'Folder already in use')
    case 'branch_conflict':
      return translate(
        'auto.components.multiRepo.root.failedBranchConflict',
        'Branch already in use'
      )
    case 'git_failed':
      return translate('auto.components.multiRepo.root.failedGit', 'Git could not create it')
    case 'setup_failed':
      return translate('auto.components.multiRepo.root.failedSetup', 'Setup failed')
    case 'repo_unavailable':
      return translate(
        'auto.components.multiRepo.root.failedRepoUnavailable',
        'Project unavailable'
      )
    case 'host_unavailable':
      return translate('auto.components.multiRepo.root.failedHostUnavailable', 'Host unavailable')
    case 'unknown':
      return translate('auto.components.multiRepo.root.failedRow', 'Failed')
  }
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s'"`:]+){2,}/g
const FAILURE_DETAIL_MAX_LENGTH = 400

/** Tooltip text for a failed row: the cause with absolute paths cut down to their last segment. */
export function getRootPanelStatusDetail(status: RootPanelRowStatus): string | undefined {
  if (status.kind !== 'failed') {
    return undefined
  }
  const detail = status.detail
    .replace(ABSOLUTE_PATH, (path) => `…/${path.split(/[\\/]/).findLast(Boolean) ?? ''}`)
    .trim()
    .slice(0, FAILURE_DETAIL_MAX_LENGTH)
  return detail || undefined
}
