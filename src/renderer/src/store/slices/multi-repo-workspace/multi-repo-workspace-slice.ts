import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import { MultiRepoWorkspaceError } from '../../../../../shared/multi-repo-workspace'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspace-execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { ipcOrRuntimeTargetForHostId } from '../../../runtime/runtime-client-target'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { holdCreatedSidebarWorkspace } from '@/lib/sidebar-pending-layer'
import { adoptFromEndpoint } from '../../adopt-from-endpoint'
import { folderWorkspaceOwnerTarget } from '../../folder-workspaces/folder-workspace-routing'
import {
  captureWorkspaceChatDraftKeys,
  deleteWorkspaceChatDrafts
} from '../worktrees/teardown/removed-worktree-chat-drafts'
import { selectFolderWorkspaces } from '../../workspace-record-selectors'
import type { MultiRepoWorkspaceSlice } from './multi-repo-workspace-contract'
import { multiRepoWorkspaceSupportedOnTarget } from './multi-repo-workspace-capability'
import { callMultiRepoWorkspace } from './multi-repo-workspace-transport'

type SliceGet = Parameters<StateCreator<AppState>>[1]

async function assertMultiRepoSupported(target: RuntimeClientTarget): Promise<void> {
  if (!(await multiRepoWorkspaceSupportedOnTarget(target))) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_capability_unsupported',
      'This host needs an update to create across repos'
    )
  }
}

function resolveOwnerTarget(
  get: SliceGet,
  folderWorkspaceId: string,
  executionHostId: Parameters<typeof findFolderWorkspaceOwner>[2]
): { target: RuntimeClientTarget; ownerHostId: ExecutionHostId } {
  const state = get()
  if (!findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)) {
    throw new MultiRepoWorkspaceError('multi_repo_workspace_not_found', 'Workspace not found')
  }
  const target = folderWorkspaceOwnerTarget(state, folderWorkspaceId, executionHostId)
  if (!target) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_workspace_not_found',
      'Workspace host unavailable'
    )
  }
  return {
    target,
    ownerHostId: getExecutionHostIdForFolderWorkspace(state, folderWorkspaceId, executionHostId)
  }
}

export const createMultiRepoWorkspaceSlice: StateCreator<
  AppState,
  [],
  [],
  MultiRepoWorkspaceSlice
> = (set, get) => {
  const replaceWorkspaceRow = (
    target: RuntimeClientTarget,
    ownerHostId: ExecutionHostId,
    row: FolderWorkspace
  ): FolderWorkspace => {
    const owned = adoptFromEndpoint(target, {
      kind: 'folderWorkspace',
      row,
      resolveOwnHostId: (candidate) => getFolderWorkspaceHostId(candidate, get().projectGroups)
    })
    set((s) => ({
      folderWorkspaces: selectFolderWorkspaces(s).map((workspace) =>
        workspace.id === owned.id &&
        getFolderWorkspaceHostId(workspace, s.projectGroups) === ownerHostId
          ? owned
          : workspace
      )
    }))
    return owned
  }

  return {
    createMultiRepoWorkspace: async (args) => {
      const state = get()
      const firstRepo = state.repos.find((repo) => repo.id === args.members[0]?.repoId)
      const target = firstRepo
        ? ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(firstRepo))
        : null
      if (!target) {
        throw new MultiRepoWorkspaceError('multi_repo_repo_not_found', 'Project not found')
      }
      await assertMultiRepoSupported(target)
      const { folderWorkspace } = await callMultiRepoWorkspace(target, 'create', args)
      const owned = adoptFromEndpoint(target, {
        kind: 'folderWorkspace',
        row: folderWorkspace,
        resolveOwnHostId: (row) => getFolderWorkspaceHostId(row, get().projectGroups)
      })
      set((s) => ({
        folderWorkspaces: [
          owned,
          ...selectFolderWorkspaces(s).filter(
            (workspace) =>
              workspace.id !== owned.id ||
              getFolderWorkspaceHostId(workspace, s.projectGroups) !==
                getFolderWorkspaceHostId(owned, s.projectGroups)
          )
        ],
        folderWorkspacePathStatuses: {}
      }))
      holdCreatedSidebarWorkspace({ folderWorkspace: owned })
      return owned
    },

    runMultiRepoMemberAction: async (action, { executionHostId, ...args }) => {
      const { target, ownerHostId } = resolveOwnerTarget(
        get,
        args.folderWorkspaceId,
        executionHostId
      )
      const { folderWorkspace } = await callMultiRepoWorkspace(target, action, args)
      return replaceWorkspaceRow(target, ownerHostId, folderWorkspace)
    },

    inspectMultiRepoWorkspaceDelete: async ({ folderWorkspaceId, executionHostId }) => {
      const { target } = resolveOwnerTarget(get, folderWorkspaceId, executionHostId)
      return callMultiRepoWorkspace(target, 'inspectDelete', { folderWorkspaceId })
    },

    deleteMultiRepoWorkspace: async ({ executionHostId, ...args }) => {
      const { target, ownerHostId } = resolveOwnerTarget(
        get,
        args.folderWorkspaceId,
        executionHostId
      )
      const workspaceKey = folderWorkspaceKey(args.folderWorkspaceId)
      // Why before the host call: its announcement can start a refresh that drops these tabs.
      const chatDraftKeys = captureWorkspaceChatDraftKeys(get(), [
        { workspaceId: workspaceKey, executionHostId: ownerHostId }
      ])
      const result = await callMultiRepoWorkspace(target, 'delete', args)
      if (result.workspaceRemoved) {
        set((s) => ({
          folderWorkspaces: selectFolderWorkspaces(s).filter(
            (workspace) =>
              workspace.id !== args.folderWorkspaceId ||
              getFolderWorkspaceHostId(workspace, s.projectGroups) !== ownerHostId
          ),
          folderWorkspacePathStatuses: {}
        }))
        if (
          !selectFolderWorkspaces(get()).some(
            (workspace) => workspace.id === args.folderWorkspaceId
          )
        ) {
          await Promise.resolve(get().shutdownWorktreeBrowsers(workspaceKey))
          void get().deleteManagedBrowserSessionProfile({ kind: 'worktree', id: workspaceKey })
          get().purgeWorktreeTerminalState([workspaceKey])
          deleteWorkspaceChatDrafts(chatDraftKeys)
        }
      } else {
        await get().fetchFolderWorkspaces({
          runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
        })
      }
      return result
    }
  }
}
