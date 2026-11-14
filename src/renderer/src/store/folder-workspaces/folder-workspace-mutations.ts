import { createFolderWorkspaceCreateAction } from './folder-workspace-creation'
import { createFolderWorkspaceDeleteAction } from './folder-workspace-removal'
import { assertWorkspaceAttachmentWriteCapability } from '../../runtime/workspace-links/runtime-workspace-attachment-capabilities'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { assertRuntimeEnvironmentCapability } from '../../runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeTargetHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { findFolderWorkspaceOwner } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import { FolderWorkspaceUpdateCoordinator } from './folder-workspace-update-coordinator'
import type { FolderWorkspaceUpdates, RepoSlice } from '../repos/repo-state'
import {
  folderWorkspaceOwnerTarget,
  folderWorkspaceUpdateInvalidatesPathStatus,
  mergeFolderWorkspaceUpdateResponse
} from './folder-workspace-routing'
import {
  getFolderWorkspaceUpdateIdentity,
  reconcileFailedFolderWorkspaceUpdate
} from './folder-workspace-catalog'
import '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'

export type FolderWorkspaceUpdateField = keyof FolderWorkspaceUpdates

export type FolderWorkspaceUpdateCoordinatorInstance =
  FolderWorkspaceUpdateCoordinator<FolderWorkspaceUpdateField>

export type RepoSliceGet = Parameters<StateCreator<AppState>>[1]

export const folderWorkspaceUpdateCoordinators = new WeakMap<
  RepoSliceGet,
  FolderWorkspaceUpdateCoordinatorInstance
>()

export function getFolderWorkspaceUpdateCoordinator(
  get: RepoSliceGet
): FolderWorkspaceUpdateCoordinatorInstance {
  const existing = folderWorkspaceUpdateCoordinators.get(get)
  if (existing) {
    return existing
  }
  const created = new FolderWorkspaceUpdateCoordinator<FolderWorkspaceUpdateField>()
  folderWorkspaceUpdateCoordinators.set(get, created)
  return created
}

export function createFolderWorkspaceMutationActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'createFolderWorkspace' | 'updateFolderWorkspace' | 'deleteFolderWorkspace'> {
  return {
    createFolderWorkspace: createFolderWorkspaceCreateAction(set, get),

    updateFolderWorkspace: async (folderWorkspaceId, updates, options) => {
      const folderWorkspaceUpdates = getFolderWorkspaceUpdateCoordinator(get)
      const state = get()
      const executionHostId =
        options?.executionHostId ??
        (state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
          ? (state.activeWorkspaceExecutionHostId ?? undefined)
          : undefined)
      const existingWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)
      if (!existingWorkspace) {
        return false
      }
      // Why: owner-scoped mutations must not follow whichever runtime happens to be focused.
      const target = folderWorkspaceOwnerTarget(state, folderWorkspaceId, executionHostId)
      if (!target) {
        return false
      }
      const ownerHostId = executionHostId ?? getRuntimeTargetHostId(target)
      const sourceWorkspace = state.folderWorkspaces.find(
        (workspace) =>
          workspace.id === folderWorkspaceId &&
          getFolderWorkspaceHostId(workspace, state.projectGroups) === ownerHostId
      )
      if (
        updates.linkedItems !== undefined &&
        updates.linkedItemsBase === undefined &&
        sourceWorkspace
      ) {
        updates = {
          ...updates,
          linkedItemsBase: getWorkspaceAttachments({
            linkedItems: sourceWorkspace.linkedItems,
            linkedWorkItem: sourceWorkspace.linkedTask,
            linkedTaskSourceContext: sourceWorkspace.linkedTaskSourceContext
          })
        }
      }
      const updateIdentity = getFolderWorkspaceUpdateIdentity(ownerHostId, folderWorkspaceId)
      if (target.kind === 'environment' && updates.linkedItems !== undefined) {
        await assertWorkspaceAttachmentWriteCapability(target, updates)
      }
      // Why: same gate as folderWorkspace.create — an older paired runtime would drop the Jira link silently.
      if (
        target.kind === 'environment' &&
        (updates.linkedTask?.provider === 'jira' ||
          updates.linkedTaskSourceContext?.provider === 'jira')
      ) {
        await assertRuntimeEnvironmentCapability(
          target.environmentId,
          WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
          'Update the remote runtime to link Jira'
        )
      }
      const updateTicket = folderWorkspaceUpdates.begin(
        updateIdentity,
        Object.keys(updates) as FolderWorkspaceUpdateField[]
      )
      try {
        const updated =
          target.kind === 'local'
            ? await window.api.folderWorkspaces.update({ folderWorkspaceId, updates })
            : (
                await callRuntimeRpc<{ folderWorkspace: FolderWorkspace | null }>(
                  target,
                  'folderWorkspace.update',
                  { folderWorkspaceId, updates },
                  { timeoutMs: 15_000 }
                )
              ).folderWorkspace
        if (!updated) {
          await reconcileFailedFolderWorkspaceUpdate({
            target,
            folderWorkspaceId,
            updateIdentity,
            ownerHostId,
            ticket: updateTicket,
            coordinator: folderWorkspaceUpdates,
            set,
            get
          })
          return false
        }
        if (
          (updates.diffComments !== undefined && updated.diffComments === undefined) ||
          (updates.linkedItems !== undefined && updated.linkedItems === undefined)
        ) {
          // Older hosts can strip optional fields; reconcile instead of reporting an unsaved edit.
          await reconcileFailedFolderWorkspaceUpdate({
            target,
            folderWorkspaceId,
            updateIdentity,
            ownerHostId,
            ticket: updateTicket,
            coordinator: folderWorkspaceUpdates,
            set,
            get
          })
          return false
        }
        const latestFields = folderWorkspaceUpdates.latestFields(updateIdentity, updateTicket)
        const catalogChanged = folderWorkspaceUpdates.catalogChanged(updateIdentity, updateTicket)
        if (latestFields.length > 0) {
          set((s) => ({
            folderWorkspaces: s.folderWorkspaces.map((workspace) =>
              workspace.id === folderWorkspaceId &&
              getFolderWorkspaceHostId(workspace, s.projectGroups) === ownerHostId
                ? mergeFolderWorkspaceUpdateResponse(workspace, updated, latestFields, {
                    rejectOlderResponse: catalogChanged
                  })
                : workspace
            ),
            ...(folderWorkspaceUpdateInvalidatesPathStatus(latestFields)
              ? { folderWorkspacePathStatuses: {} }
              : {})
          }))
        }
        return true
      } catch (err) {
        console.error('Failed to update folder workspace:', err)
        await reconcileFailedFolderWorkspaceUpdate({
          target,
          folderWorkspaceId,
          updateIdentity,
          ownerHostId,
          ticket: updateTicket,
          coordinator: folderWorkspaceUpdates,
          set,
          get
        })
        return false
      } finally {
        folderWorkspaceUpdates.finish(updateIdentity, updateTicket)
      }
    },

    deleteFolderWorkspace: createFolderWorkspaceDeleteAction(set, get)
  }
}
