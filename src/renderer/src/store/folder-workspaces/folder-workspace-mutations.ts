import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../runtime/runtime-rpc-client'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { formatFolderWorkspaceCreateError } from '../../lib/folder-workspace-path-status'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace,
  getRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import { FolderWorkspaceUpdateCoordinator } from '../slices/folder-workspace-update-coordinator'
import type { FolderWorkspaceUpdates, RepoSlice } from '../repos/repo-state'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import {
  folderWorkspaceUpdateInvalidatesPathStatus,
  getFolderWorkspacePathStatusRouteSettings,
  mergeFolderWorkspaceUpdateResponse
} from './folder-workspace-routing'
import {
  folderWorkspaceWithFetchedOwner,
  getFolderWorkspaceHostId,
  getFolderWorkspaceUpdateIdentity,
  reconcileFailedFolderWorkspaceUpdate
} from './folder-workspace-catalog'

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
    createFolderWorkspace: async (args, options) => {
      try {
        // Why: a new folder has no owner yet, so creation follows the caller-selected path-status host.
        const target = getActiveRuntimeTarget(
          getFolderWorkspacePathStatusRouteSettings(options, get().settings)
        )
        if (
          target.kind === 'environment' &&
          (args.linkedTask?.provider === 'jira' ||
            args.linkedTaskSourceContext?.provider === 'jira')
        ) {
          await assertRuntimeEnvironmentCapability(
            target.environmentId,
            WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
            'Update the remote runtime to link Jira'
          )
        }
        const workspace =
          target.kind === 'local'
            ? await window.api.folderWorkspaces.create(args)
            : (
                await callRuntimeRpc<{ folderWorkspace: FolderWorkspace }>(
                  target,
                  'folderWorkspace.create',
                  args,
                  { timeoutMs: 15_000 }
                )
              ).folderWorkspace
        const ownedWorkspace = folderWorkspaceWithFetchedOwner(
          workspace,
          target,
          get().projectGroups
        )
        set((s) => ({
          folderWorkspaces: [ownedWorkspace, ...s.folderWorkspaces],
          folderWorkspacePathStatuses: {}
        }))
        return ownedWorkspace
      } catch (err) {
        console.error('Failed to create folder workspace:', err)
        const { title, description } = formatFolderWorkspaceCreateError(err)
        throw new Error(`${title}. ${description}`)
      }
    },

    updateFolderWorkspace: async (folderWorkspaceId, updates, options) => {
      const folderWorkspaceUpdates = getFolderWorkspaceUpdateCoordinator(get)
      const state = get()
      const executionHostId =
        options?.executionHostId ??
        (state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
          ? (state.activeWorkspaceExecutionHostId ?? undefined)
          : undefined)
      if (!findFolderWorkspaceOwner(state, folderWorkspaceId, executionHostId)) {
        return false
      }
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderWorkspace(
        state,
        folderWorkspaceId,
        executionHostId
      )
      // Why: owner-scoped mutations must not follow whichever runtime happens to be focused.
      const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId: runtimeEnvironmentId })
      const ownerHostId = executionHostId ?? getRuntimeTargetHostId(target)
      const updateIdentity = getFolderWorkspaceUpdateIdentity(ownerHostId, folderWorkspaceId)
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
        if (updates.diffComments !== undefined && updated.diffComments === undefined) {
          // Why: older paired runtimes strip this optional field; reconcile instead of showing an unsaved note.
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

    deleteFolderWorkspace: async (folderWorkspaceId, options) => {
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
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForFolderWorkspace(
        state,
        folderWorkspaceId,
        executionHostId
      )
      try {
        // Why: deletion targets the folder's owner; focus may be on a different host.
        const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId: runtimeEnvironmentId })
        const deleted =
          target.kind === 'local'
            ? await window.api.folderWorkspaces.delete({ folderWorkspaceId })
            : (
                await callRuntimeRpc<{ deleted: boolean }>(
                  target,
                  'folderWorkspace.delete',
                  { folderWorkspaceId },
                  { timeoutMs: 15_000 }
                )
              ).deleted
        if (!deleted) {
          return false
        }
        const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
        set((s) => ({
          folderWorkspaces: s.folderWorkspaces.filter(
            (workspace) =>
              workspace.id !== folderWorkspaceId ||
              getFolderWorkspaceHostId(workspace, s.projectGroups) !== ownerHostId
          ),
          folderWorkspacePathStatuses: {}
        }))
        if (!get().folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
          get().purgeWorktreeTerminalState([workspaceKey])
        }
        return true
      } catch (err) {
        console.error('Failed to delete folder workspace:', err)
        return false
      }
    }
  }
}
