import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { buildSidebarDefaultAgentStartup } from '@/lib/sidebar-default-agent-startup'

type SidebarActivationOptions = {
  launchDefaultAgent?: boolean
}

export async function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId,
  options?: SidebarActivationOptions
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
  // Keep navigation independent from an optional runtime wake IPC.
  // Why: seed-if-empty is not hasActivationWork, so the gate still adopts live/unverifiable surfaces.
  const seedStartupIfEmpty = options?.launchDefaultAgent
    ? resolveSidebarDefaultAgentStartup(worktreeId, executionHostId)
    : undefined
  activateAndRevealWorktree(worktreeId, {
    revealInSidebar: false,
    ...(seedStartupIfEmpty ? { seedStartupIfEmpty } : {}),
    ...(executionHostId ? { executionHostId } : {})
  })

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
    }
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
  const selectedHostId = worktree.hostId ?? executionHostId ?? LOCAL_EXECUTION_HOST_ID
  // Why: the bare-id local runtime lookup can hit a Windows/WSL twin of an SSH/runtime row.
  const projectRuntime =
    selectedHostId === LOCAL_EXECUTION_HOST_ID && !repoIsRemote(repo)
      ? getLocalProjectExecutionRuntimeContext(state, worktreeId)
      : undefined
  return buildSidebarDefaultAgentStartup(state.settings, repo, projectRuntime)
}
