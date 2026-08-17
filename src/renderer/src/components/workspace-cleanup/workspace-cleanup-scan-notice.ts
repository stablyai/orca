import { translate } from '@/i18n/i18n'
import type {
  WorkspaceCleanupScanError,
  WorkspaceCleanupScanProgress
} from '../../../../shared/workspace-cleanup'

function isDisconnectedRemoteScanError(message: string): boolean {
  return (
    message === 'SSH provider is unavailable.' ||
    message === 'Remote workspaces are not connected. Reconnect and refresh to check them.'
  )
}

export function formatWorkspaceCleanupScanNotice(
  errors: readonly WorkspaceCleanupScanError[],
  repoNameById: ReadonlyMap<string, string>
): string | null {
  const visibleErrors = errors.filter(
    (error) => !isDisconnectedRemoteScanError(error.message ?? '')
  )
  if (visibleErrors.length === 0) {
    return null
  }
  if (visibleErrors.length === 1) {
    const error = visibleErrors[0]
    const repoName = formatScanErrorRepoName(error, repoNameById)
    return translate(
      'components.workspace.cleanup.scan.singleError',
      'Could not check {{value0}}: {{value1}}. Some workspaces may be missing. Refresh to try again.',
      { value0: repoName, value1: formatScanErrorReason(error.message) }
    )
  }
  const repoNames = visibleErrors
    .slice(0, 3)
    .map((error) => formatScanErrorRepoName(error, repoNameById))
    .join(', ')
  const moreCount = visibleErrors.length - 3
  const suffix =
    moreCount > 0
      ? translate('components.workspace.cleanup.scan.moreErrors', ', +{{value0}} more', {
          value0: moreCount
        })
      : ''
  return translate(
    'components.workspace.cleanup.scan.multipleErrors',
    'Could not check {{value0}} repositories ({{value1}}{{value2}}). Some workspaces may be missing. Refresh to try again.',
    { value0: visibleErrors.length, value1: repoNames, value2: suffix }
  )
}

export function formatWorkspaceCleanupScanProgress(
  progress: WorkspaceCleanupScanProgress | null
): string {
  if (!progress || progress.scannedWorktreeCount === 0) {
    return translate(
      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4cc5b73efe',
      'Finding workspaces...'
    )
  }
  return translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7b7bde5181',
    'Checked workspaces so far: {{value0}}',
    { value0: progress.scannedWorktreeCount }
  )
}

export function formatWorkspaceCleanupReadyToast(
  workspaceCount: number,
  suggestedCount: number
): string {
  if (workspaceCount === 0) {
    return translate('components.workspace.cleanup.scan.noWorkspaces', 'No workspaces found.')
  }
  if (workspaceCount === 1) {
    return suggestedCount === 1
      ? translate(
          'components.workspace.cleanup.scan.readyOneOne',
          '1 workspace found, with 1 cleanup suggestion.'
        )
      : translate(
          'components.workspace.cleanup.scan.readyOneMany',
          '1 workspace found, with {{value0}} cleanup suggestions.',
          { value0: suggestedCount }
        )
  }
  return suggestedCount === 1
    ? translate(
        'components.workspace.cleanup.scan.readyManyOne',
        '{{value0}} workspaces found, with 1 cleanup suggestion.',
        { value0: workspaceCount }
      )
    : translate(
        'components.workspace.cleanup.scan.readyManyMany',
        '{{value0}} workspaces found, with {{value1}} cleanup suggestions.',
        { value0: workspaceCount, value1: suggestedCount }
      )
}

function formatScanErrorRepoName(
  error: Partial<WorkspaceCleanupScanError>,
  repoNameById: ReadonlyMap<string, string>
): string {
  const repoName = error.repoName?.trim()
  if (repoName) {
    return repoName
  }
  const fallback = error.repoId ? repoNameById.get(error.repoId)?.trim() : ''
  return (
    fallback || translate('components.workspace.cleanup.scan.fallbackRepository', 'a repository')
  )
}

function formatScanErrorReason(message: string | undefined): string {
  if (!message || message === 'Could not scan workspace cleanup for this repository.') {
    return translate(
      'components.workspace.cleanup.scan.gitListFailed',
      'Git could not list worktrees'
    )
  }
  return message.replace(/\.$/, '')
}
