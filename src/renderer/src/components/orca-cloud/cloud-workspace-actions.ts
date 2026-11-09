// User actions on an Orca Cloud workspace, with their toasts. Archive reuses the ordinary Sleep
// flow (terminals and chats saved first); unarchive and Wake reuse the ordinary open-and-wake path.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import {
  archiveCloudWorkspace,
  restartCloudWorkspace,
  unarchiveCloudWorkspace
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

function failureToast(title: string, result: CloudWorkspaceResult<null>): void {
  if (result.ok) {
    return
  }
  const description =
    result.code === 'entitlement_denied'
      ? translate(
          'orcaCloudWorkspace.error.noHours',
          'Your plan has no cloud hours left. Files are safe; add hours to start it again.'
        )
      : result.code === 'unavailable'
        ? translate('orcaCloudWorkspace.error.unavailable', 'Orca Cloud is not reachable right now. Try again in a moment.')
        : result.message
  toast.error(title, { description })
}

export async function runRestartCloudWorkspace(workspaceId: string): Promise<void> {
  const result = await restartCloudWorkspace(workspaceId)
  failureToast(translate('orcaCloudWorkspace.restartFailed', 'Couldn’t restart the workspace'), result)
  if (result.ok) {
    toast.success(
      translate('orcaCloudWorkspace.restarted', 'Workspace restarted'),
      {
        description: translate(
          'orcaCloudWorkspace.restartedDetail',
          'Files kept. Interrupted agents are continuing.'
        )
      }
    )
  }
}

export async function runArchiveCloudWorkspace(workspaceId: string): Promise<void> {
  const result = await archiveCloudWorkspace(workspaceId, { sleep: runSleepWorktree })
  failureToast(translate('orcaCloudWorkspace.archiveFailed', 'Couldn’t archive the workspace'), result)
  if (result.ok) {
    toast.success(translate('orcaCloudWorkspace.archived.toast', 'Workspace archived'), {
      description: translate(
        'orcaCloudWorkspace.archived.toastDetail',
        'Its PRs, last changes and files stay browsable. It no longer uses cloud hours.'
      ),
      action: {
        label: translate('orcaCloudWorkspace.unarchive', 'Unarchive'),
        onClick: () => void runUnarchiveCloudWorkspace(workspaceId)
      }
    })
  }
}

export async function runUnarchiveCloudWorkspace(workspaceId: string): Promise<void> {
  const result = await unarchiveCloudWorkspace(workspaceId, {
    wake: (id) => activateWorktreeFromSidebar(id)
  })
  failureToast(translate('orcaCloudWorkspace.unarchiveFailed', 'Couldn’t unarchive the workspace'), result)
}

export function wakeCloudWorkspace(workspaceId: string): Promise<void> {
  return activateWorktreeFromSidebar(workspaceId)
}
