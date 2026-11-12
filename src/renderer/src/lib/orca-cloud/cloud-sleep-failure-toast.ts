// Sleep that left an Orca Cloud sandbox running: glossary copy (sleep, sandbox hours, files safe)
// instead of the generic VM wording, with a Try again that reruns the ordinary Sleep.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { getCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { isPairedCloudSleepTarget } from './paired-cloud-sleep'

export function isCloudWorkspaceId(worktreeId: string): boolean {
  // Paired workspaces' sandboxes too: their failed Sleep leaves a sandbox running just the same.
  return getCloudWorkspaceSnapshot().ids.has(worktreeId) || isPairedCloudSleepTarget(worktreeId)
}

function workspaceName(worktreeId: string): string {
  return (
    findWorktreeById(useAppStore.getState(), worktreeId)?.displayName ??
    translate('orcaCloudWorkspace.thisWorkspace', 'This workspace')
  )
}

/** True when it showed the cloud toast (every id is an Orca Cloud workspace). */
export function toastCloudSleepFailure(
  worktreeIds: readonly string[],
  retry: (ids: readonly string[]) => void
): boolean {
  if (worktreeIds.length === 0 || !worktreeIds.every(isCloudWorkspaceId)) {
    return false
  }
  const title =
    worktreeIds.length === 1
      ? translate('orcaCloudWorkspace.sleepFailedNamed', 'Couldn’t put {{name}} to sleep', {
          name: workspaceName(worktreeIds[0]!)
        })
      : translate(
          'orcaCloudWorkspace.sleepFailedCount',
          'Couldn’t put {{count}} workspaces to sleep',
          {
            count: worktreeIds.length
          }
        )
  toast.error(title, {
    description: translate(
      'orcaCloudWorkspace.sleepFailedDetail',
      'Its sandbox is still running and using sandbox hours. Your files are safe.'
    ),
    action: {
      label: translate('orcaCloudWorkspace.tryAgain', 'Try again'),
      onClick: () => retry(worktreeIds)
    }
  })
  return true
}
