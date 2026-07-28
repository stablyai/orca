import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  beginWorkspaceActivationIntent,
  isCurrentWorkspaceActivationIntent
} from './workspace-activation-intent'

export async function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<void> {
  const activationIntent = beginWorkspaceActivationIntent()
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
      // Why: VM resume can take seconds. A later sidebar click owns navigation
      // AND the runtime-env refresh — a stale request must not mutate either.
      if (!isCurrentWorkspaceActivationIntent(activationIntent)) {
        return
      }
      if (runtime?.runtimeEnvironmentId) {
        const store = (await import('@/store')).useAppStore
        if (!isCurrentWorkspaceActivationIntent(activationIntent)) {
          return
        }
        const runtimeEnvironments = await window.api.runtimeEnvironments.list()
        if (!isCurrentWorkspaceActivationIntent(activationIntent)) {
          return
        }
        store.getState().setRuntimeEnvironments(runtimeEnvironments)
        await store.getState().refreshRuntimeEnvironmentStatus(runtime.runtimeEnvironmentId)
        if (!isCurrentWorkspaceActivationIntent(activationIntent)) {
          return
        }
      }
    } catch (error) {
      if (!isCurrentWorkspaceActivationIntent(activationIntent)) {
        return
      }
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
