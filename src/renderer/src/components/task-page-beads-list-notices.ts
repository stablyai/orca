import { translate } from '@/i18n/i18n'
import type { TaskPageBeadsListState, TaskPageBeadsRepoResult } from './task-page-beads-issues'

export type BeadsListNoticeCopy = { title: string; body: string }

export type TaskPageBeadsRepoNotice = {
  repoId: string | null
  kind: 'load-failed' | 'capability-missing' | 'bd-missing' | 'bd-outdated' | 'not-initialized'
}

/** Per-repo failure/setup banner rows for mixed selections — the GitHub per-repo error-row analog; a failed repo must not silently vanish from the merged list. */
export function deriveTaskPageBeadsRepoNotices(
  results: readonly TaskPageBeadsRepoResult[]
): TaskPageBeadsRepoNotice[] {
  const notices: TaskPageBeadsRepoNotice[] = []
  for (const result of results) {
    if (!result.checked) {
      continue
    }
    const repoId = result.context.repoId ?? null
    if (result.error === 'load-failed') {
      notices.push({ repoId, kind: 'load-failed' })
      continue
    }
    if (result.error === 'missing-task-source-capability') {
      notices.push({ repoId, kind: 'capability-missing' })
      continue
    }
    const status = result.status
    if (!status) {
      continue
    }
    if (!status.bdInstalled) {
      notices.push({ repoId, kind: 'bd-missing' })
    } else if (!status.versionSupported) {
      notices.push({ repoId, kind: 'bd-outdated' })
    } else if (!status.initialized) {
      notices.push({ repoId, kind: 'not-initialized' })
    }
  }
  return notices
}

/** Copy for the non-table beads list states: setup hints, errors, and empties. */
export function getBeadsListNoticeCopy(
  state: Exclude<TaskPageBeadsListState, 'loading' | 'ready'>
): BeadsListNoticeCopy {
  switch (state) {
    case 'capability-missing':
      return {
        title: translate(
          'auto.components.TaskPage.beadsCapabilityMissingTitle',
          'Server update needed'
        ),
        body: translate(
          'auto.components.TaskPage.beadsCapabilityMissingBody',
          'Update the remote Orca server to browse Beads issues from this host.'
        )
      }
    case 'bd-missing':
      return {
        title: translate('auto.components.TaskPage.beadsBdMissingTitle', 'Beads CLI not found'),
        body: translate(
          'auto.components.TaskPage.beadsBdMissingBody',
          'Install the bd CLI on the host where this project lives to browse Beads issues.'
        )
      }
    case 'bd-outdated':
      return {
        title: translate('auto.components.TaskPage.beadsBdOutdatedTitle', 'Update the bd CLI'),
        body: translate(
          'auto.components.TaskPage.beadsBdOutdatedBody',
          'Beads issues need bd 1.1.0 or newer on the host where this project lives.'
        )
      }
    case 'not-initialized':
      return {
        title: translate(
          'auto.components.TaskPage.beadsNotInitializedTitle',
          'Beads isn’t initialized in this project'
        ),
        body: translate(
          'auto.components.TaskPage.beadsNotInitializedBody',
          'Run `bd init` in the repository to start tracking issues, then refresh.'
        )
      }
    case 'error':
      return {
        title: translate(
          'auto.components.TaskPage.beadsLoadErrorTitle',
          'Couldn’t load Beads issues'
        ),
        body: translate(
          'auto.components.TaskPage.beadsLoadErrorBody',
          'Check that bd works in this repository, then refresh.'
        )
      }
    case 'empty-filtered':
      return {
        title: translate('auto.components.TaskPage.beadsEmptyTitle', 'No Beads issues found'),
        body: translate(
          'auto.components.TaskPage.beadsEmptyFilteredBody',
          'Try a different search.'
        )
      }
    case 'empty':
      return {
        title: translate('auto.components.TaskPage.beadsEmptyTitle', 'No Beads issues found'),
        body: translate(
          'auto.components.TaskPage.94d900518d',
          'No issues match the selected preset.'
        )
      }
  }
}
