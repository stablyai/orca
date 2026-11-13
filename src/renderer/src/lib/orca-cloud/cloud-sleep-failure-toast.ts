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

function workspaceName(worktreeId: string): string | null {
  return findWorktreeById(useAppStore.getState(), worktreeId)?.displayName || null
}

function sleepFailedTitle(worktreeIds: readonly string[]): string {
  if (worktreeIds.length > 1) {
    return translate(
      'orcaCloudWorkspace.sleepFailedCount',
      'Couldn’t put {{count}} workspaces to sleep',
      { count: worktreeIds.length }
    )
  }
  const name = workspaceName(worktreeIds[0]!)
  // No name: its own sentence, never "This workspace" spliced into the middle.
  return name
    ? translate('orcaCloudWorkspace.sleepFailedNamed', 'Couldn’t put {{name}} to sleep', { name })
    : translate('orcaCloudWorkspace.sleepFailedUnnamed', 'Couldn’t put this workspace to sleep')
}

/** True when it showed the cloud toast (every id is an Orca Cloud workspace). */
export function toastCloudSleepFailure(
  worktreeIds: readonly string[],
  retry: (ids: readonly string[]) => void
): boolean {
  if (worktreeIds.length === 0 || !worktreeIds.every(isCloudWorkspaceId)) {
    return false
  }
  toast.error(sleepFailedTitle(worktreeIds), {
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
