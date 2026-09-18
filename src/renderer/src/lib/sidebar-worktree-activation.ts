import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { buildSidebarDefaultAgentStartup } from '@/lib/sidebar-default-agent-startup'

type SidebarActivationOptions = {
  launchDefaultAgent?: boolean
  revealInSidebar?: boolean
}

export async function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId,
  options?: SidebarActivationOptions
): Promise<void> {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
      navigationIntent: 'user-open',
      ...options,
      ...(executionHostId ? { executionHostId } : {})
    })
    return
  }
  // Keep navigation independent from an optional runtime wake IPC.
  const startup = options?.launchDefaultAgent
    ? resolveSidebarDefaultAgentStartup(worktreeId, executionHostId)
    : undefined
  activateAndRevealWorktree(worktreeId, {
    navigationIntent: 'user-open',
    revealInSidebar: false,
    ...(startup ? { startup } : {}),
    ...(executionHostId ? { executionHostId } : {})
  })

  await resumeEphemeralVmWorkspace(worktreeId)
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

function resolveSidebarDefaultAgentStartup(worktreeId: string, executionHostId?: ExecutionHostId) {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return undefined
  }
  const repo = findRepoForHost(state.repos, worktree.repoId, {
    hostId: worktree.hostId ?? executionHostId,
    settings: state.settings
  })
  if (!repo) {
    return undefined
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return buildSidebarDefaultAgentStartup(state.settings, repo, projectRuntime)
}
