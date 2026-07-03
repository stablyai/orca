import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { isEphemeralVmRuntimeEnvironment } from '../../../shared/runtime-environments'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

function shouldResumeEphemeralVmWorkspace(worktreeId: string): boolean {
  const state = useAppStore.getState()
  const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!runtimeEnvironmentId) {
    return false
  }

  const runtimeEnvironment = state.runtimeEnvironments.find(
    (environment) => environment.id === runtimeEnvironmentId
  )
  // Why: runtime metadata hydrates asynchronously at startup. If an explicitly
  // runtime-owned workspace has not loaded its source yet, main can still no-op
  // non-VM workspace ids while preserving wake for suspended VM workspaces.
  return runtimeEnvironment ? isEphemeralVmRuntimeEnvironment(runtimeEnvironment) : true
}

export async function activateWorktreeFromSidebar(worktreeId: string): Promise<void> {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    return
  }

  if (
    shouldResumeEphemeralVmWorkspace(worktreeId) &&
    typeof window !== 'undefined' &&
    window.api?.ephemeralVm?.resumeWorkspace
  ) {
    try {
      await window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
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
  activateAndRevealWorktree(worktreeId, { revealInSidebar: false })
}
