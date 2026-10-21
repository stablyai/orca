import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { wakeMachineForHost } from '@/lib/machines/machine-wake-on-open'
import { hasMachineProviders } from '@/store/machines'

export async function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<void> {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  // Why: the wake starts (and marks the worktree) before navigation mounts its terminals, so they
  // hold their attach until wake and connect settle. Navigation still never waits on it.
  if (workspaceScope?.type === 'folder') {
    const wake = startMachineWake(
      () => executionHostId ?? getFolderWorkspaceHostIdById(workspaceScope.folderWorkspaceId),
      worktreeId
    )
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
      navigationIntent: 'user-open',
      ...(executionHostId ? { executionHostId } : {})
    })
    await wake
    return
  }
  const wake = startMachineWake(() => executionHostId ?? getWorktreeHostId(worktreeId), worktreeId)
  activateAndRevealWorktree(worktreeId, {
    navigationIntent: 'user-open',
    revealInSidebar: false,
    ...(executionHostId ? { executionHostId } : {})
  })

  await Promise.all([resumeEphemeralVmWorkspace(worktreeId), wake])
}

function startMachineWake(
  hostId: () => ExecutionHostId | null,
  worktreeId: string
): Promise<void> | undefined {
  try {
    // Why: skip the host lookup entirely for the common case of no machine providers.
    return hasMachineProviders() ? wakeMachineForHost(hostId(), worktreeId) : undefined
  } catch (error) {
    // Why: this runs before navigation now, and a wake lookup must never block opening a worktree.
    console.error('Failed to start the machine wake for', worktreeId, error)
    return undefined
  }
}

function getFolderWorkspaceHostIdById(folderWorkspaceId: string): ExecutionHostId | null {
  const state = useAppStore.getState()
  const workspace = state.folderWorkspaces.find((candidate) => candidate.id === folderWorkspaceId)
  return workspace ? getFolderWorkspaceHostId(workspace, state.projectGroups) : null
}

function getWorktreeHostId(worktreeId: string): ExecutionHostId | null {
  const state = useAppStore.getState()
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (!worktree) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  return getWorktreeExecutionHostId(worktree, repo)
}

/** Wakes the per-workspace VM behind a worktree, if it has one. */
async function resumeEphemeralVmWorkspace(worktreeId: string): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.resumeWorkspace) {
    return
  }
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
  }
}
