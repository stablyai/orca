import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../shared/execution-host'

export async function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<void> {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    if (executionHostId) {
      activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
        executionHostId
      })
    } else {
      activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    }
    return
  }

  if (typeof window !== 'undefined' && window.api?.ephemeralVm?.resumeWorkspace) {
    try {
      const runtime = await window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
      if (runtime?.runtimeEnvironmentId) {
        const store = (await import('@/store')).useAppStore
        store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
        await store.getState().refreshRuntimeEnvironmentStatus(runtime.runtimeEnvironmentId)
      }
    } catch (error) {
      toast.error(
        translate(
          'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
          'Failed to wake ephemeral VM workspace'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
      return
    }
  }

  // Why: sidebar clicks already happen on a visible row; revealing again can
  // jump duplicate pinned/canonical entries back to the first mounted copy.
  activateAndRevealWorktree(worktreeId, {
    revealInSidebar: false,
    ...(executionHostId ? { executionHostId } : {})
  })
}
