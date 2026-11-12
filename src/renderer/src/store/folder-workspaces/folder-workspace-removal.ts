import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { confirmInspectedArchiveHook } from '@/runtime/repo-hooks/ensure-hooks-confirmed'
import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'
import { resolveHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { resolveFolderSetupSupported } from '@/lib/workspace/creation/setup/folder-setup-support'
import { PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import {
  worktreeRemovalReplyTimeoutMs,
  isArchiveHookRemovalError
} from '../../../../shared/worktree/archive-hook-removal-gate'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { launchDraftSource } from '@/components/native-chat/drafts/native-chat-launch-draft-source'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace
} from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import type { RepoSlice } from '../repos/repo-state'
import { folderWorkspaceOwnerTarget } from './folder-workspace-routing'
import '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'
import * as chatDrafts from '../slices/worktrees/teardown/removed-worktree-chat-drafts'

export function createFolderWorkspaceDeleteAction(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['deleteFolderWorkspace'] {
  return async (folderWorkspaceId, options) => {
    const state = get()
    const executionHostId = options?.executionHostId
    if (!findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)) {
      return false
    }
    const ownerHostId = getExecutionHostIdForFolderWorkspace(
      state,
      folderWorkspaceId,
      executionHostId
    )
    const target = folderWorkspaceOwnerTarget(state, folderWorkspaceId, executionHostId)
    if (!target) {
      return false
    }
    const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
    // Why before the host call: its announcement can start a refresh that drops these tabs.
    const chatDraftKeys = chatDrafts.captureWorkspaceChatDraftKeys(state, [
      { workspaceId: workspaceKey, executionHostId: ownerHostId }
    ])
    try {
      const workspace = findFolderWorkspaceOwner(state, folderWorkspaceId, ownerHostId)
      const group =
        workspace &&
        state.projectGroups.find(
          (entry) =>
            entry.id === workspace.projectGroupId && getRepoExecutionHostId(entry) === ownerHostId
        )
      const owner = group && projectGroupHookOwner(group)
      const supported =
        owner &&
        (await resolveFolderSetupSupported(owner, PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY))
      let runHooks = false
      if (supported && group && owner) {
        const checked = await checkRuntimeGroupHooks(ownerHostId, group.id, { background: true })
        if (
          checked.status !== 'error' &&
          !checked.unavailable &&
          !(checked.hasHooks && !checked.hooks)
        ) {
          const policy = resolveHookCommandSourcePolicy(checked.hookSettings?.commandSourcePolicy, {
            hasLocalScript: Boolean(checked.hookSettings?.scripts.archive?.trim())
          })
          const shared =
            policy === 'local-only' ? '' : (checked.hooks?.scripts.archive?.trim() ?? '')
          runHooks =
            !shared ||
            (await confirmInspectedArchiveHook(get, owner.id, ownerHostId, shared)).decision ===
              'run'
        }
      }
      const request = {
        folderWorkspaceId,
        ...(supported
          ? {
              runHooks,
              ...(options?.allowFailedArchiveHook ? { allowFailedArchiveHook: true } : {})
            }
          : {})
      }
      const deleted =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.delete(request)
          : (
              await callRuntimeRpc<{ deleted: boolean }>(
                target,
                'folderWorkspace.delete',
                request,
                { timeoutMs: supported ? worktreeRemovalReplyTimeoutMs(runHooks) : 15_000 }
              )
            ).deleted
      if (!deleted) {
        return false
      }
      set((s) => ({
        folderWorkspaces: s.folderWorkspaces.filter(
          (workspace) =>
            workspace.id !== folderWorkspaceId ||
            getFolderWorkspaceHostId(workspace, s.projectGroups) !== ownerHostId
        ),
        folderWorkspacePathStatuses: {}
      }))
      const origin = target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`
      chatDrafts.deleteWorkspaceChatDraftOwners(
        chatDraftKeys,
        (owner, scope) =>
          owner.workspaceId === workspaceKey && launchDraftSource(scope)?.origin === origin
      )
      if (!get().folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
        // Folder/worktree browser registry keys coincide; retire Chromium guests before renderer cleanup.
        await Promise.resolve(get().shutdownWorktreeBrowsers(workspaceKey))
        // Why here too: a server-hosted folder's local pages use this desktop's profile, which the server can't reach.
        void get().deleteManagedBrowserSessionProfile({ kind: 'worktree', id: workspaceKey })
        get().purgeWorktreeTerminalState([workspaceKey])
        chatDrafts.deleteWorkspaceChatDrafts(chatDraftKeys)
      }
      return true
    } catch (err) {
      console.error('Failed to delete folder workspace:', err)
      const error = err instanceof Error ? err.message : String(err)
      if (isArchiveHookRemovalError(error)) {
        const { showDeleteWorktreeFailureToast } =
          await import('@/components/sidebar/workspace-actions/deletion/delete-worktree-failure-toast')
        showDeleteWorktreeFailureToast({
          error,
          canForceDelete: false,
          forceDeleteReason: null,
          canWaiveArchiveHook: true,
          onViewChanges: () => {},
          onForceDelete: () => {},
          onDeleteAnyway: () => {
            void get()
              .deleteFolderWorkspace(folderWorkspaceId, {
                executionHostId: ownerHostId,
                allowFailedArchiveHook: true
              })
              .then((deleted) => {
                if (
                  deleted &&
                  get().activeWorktreeId === workspaceKey &&
                  get().activeWorkspaceExecutionHostId === ownerHostId
                ) {
                  get().setActiveWorktree(null)
                }
              })
          },
          worktreeId: workspaceKey,
          executionHostId: ownerHostId,
          worktreeName:
            state.folderWorkspaces.find(
              (workspace) =>
                workspace.id === folderWorkspaceId &&
                getFolderWorkspaceHostId(workspace, state.projectGroups) === ownerHostId
            )?.name ?? folderWorkspaceId
        })
      }
      return false
    }
  }
}
