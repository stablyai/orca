import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceCleanupScanError } from '../../../../shared/workspace-cleanup/workspace-cleanup'

function isDisconnectedRemoteScanError(message: string): boolean {
  return (
    message === 'SSH provider is unavailable.' ||
    message === 'Remote workspaces are not connected. Reconnect and refresh to check them.'
  )
}

export function formatWorkspaceCleanupScanNotice(
  errors: readonly WorkspaceCleanupScanError[],
  repoNameById: ReadonlyMap<string, string>,
  t: Translate = translate
): string | null {
  const visibleErrors = errors.filter(
    (error) => !isDisconnectedRemoteScanError(error.message ?? '')
  )
  if (visibleErrors.length === 0) {
    return null
  }
  if (visibleErrors.length === 1) {
    const error = visibleErrors[0]
    const repoName = formatScanErrorRepoName(error, repoNameById, t)
    return t(
      'components.workspace.cleanup.scan.singleError',
      'Could not check {{value0}}: {{value1}}. Some workspaces may be missing. Refresh to try again.',
      { value0: repoName, value1: formatScanErrorReason(error.message, t) }
    )
  }
  const repoNames = visibleErrors
    .slice(0, 3)
    .map((error) => formatScanErrorRepoName(error, repoNameById, t))
    .join(', ')
  const moreCount = visibleErrors.length - 3
  return moreCount > 0
    ? t(
        'components.workspace.cleanup.scan.multipleErrorsWithMore',
        'Could not check {{count}} repositories ({{names}}, +{{moreCount}} more). Some workspaces may be missing. Refresh to try again.',
        {
          count: visibleErrors.length,
          names: repoNames,
          moreCount,
          defaultValue_one:
            'Could not check {{count}} repository ({{names}}, +{{moreCount}} more). Some workspaces may be missing. Refresh to try again.'
        }
      )
    : t(
        'components.workspace.cleanup.scan.multipleErrorsCount',
        'Could not check {{count}} repositories ({{names}}). Some workspaces may be missing. Refresh to try again.',
        {
          count: visibleErrors.length,
          names: repoNames,
          defaultValue_one:
            'Could not check {{count}} repository ({{names}}). Some workspaces may be missing. Refresh to try again.'
        }
      )
}

export function formatWorkspaceCleanupReadyToast(workspaceCount: number): string {
  if (workspaceCount === 0) {
    return translate('components.workspace.cleanup.scan.noWorkspaces', 'No workspaces found.')
  }
  return translate('components.workspace.cleanup.scan.readyCount', '{{count}} workspaces found.', {
    count: workspaceCount,
    defaultValue_one: '{{count}} workspace found.'
  })
}

function formatScanErrorRepoName(
  error: Partial<WorkspaceCleanupScanError>,
  repoNameById: ReadonlyMap<string, string>,
  t: Translate = translate
): string {
  const repoName = error.repoName?.trim()
  if (repoName) {
    return repoName
  }
  const fallback = error.repoId ? repoNameById.get(error.repoId)?.trim() : ''
  return fallback || t('components.workspace.cleanup.scan.fallbackRepository', 'a repository')
}

function formatScanErrorReason(message: string | undefined, t: Translate = translate): string {
  if (!message || message === 'Could not scan workspace cleanup for this repository.') {
    return t('components.workspace.cleanup.scan.gitListFailed', 'Git could not list worktrees')
  }
  return message.replace(/\.$/, '')
}
