import type { StateCreator } from 'zustand'
import { translate } from '@/i18n/i18n'
import { showWorktreeCreateWarningToast } from '../slices/worktrees/create/worktree-create-warning-toast'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type { FolderWorkspaceCreateResult } from '../../../../shared/folder-workspaces/folder-workspace-create'
import { assertWorkspaceAttachmentWriteCapability } from '../../runtime/workspace-links/runtime-workspace-attachment-capabilities'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { assertRuntimeEnvironmentCapability } from '../../runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetForOwnerEnvironment } from '../../runtime/rpc/targets/runtime-client-target'
import { formatFolderWorkspaceCreateError } from '../../lib/workspace/paths/folder-workspace-path-status'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { holdCreatedSidebarWorkspace } from '@/components/sidebar/sidebar-feed/sidebar-pending-layer'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspaces/folder-workspace-host-id'
import { mergeCreatedFolderWorkspace } from './folder-workspace-catalog'
import { selectFolderWorkspaces } from '../workspaces/catalog/workspace-record-fields'

export function createFolderWorkspaceCreateAction(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['createFolderWorkspace'] {
  return async (args, options) => {
    try {
      const pinNewWorkspace = get().settings?.pinNewWorkspaces === true
      // Why: a new folder has no row yet, so creation goes to the host the caller picked.
      const target = runtimeTargetForOwnerEnvironment(options.runtimeEnvironmentId)
      await assertWorkspaceAttachmentWriteCapability(target, args)
      if (
        target.kind === 'environment' &&
        (args.linkedTask?.provider === 'jira' || args.linkedTaskSourceContext?.provider === 'jira')
      ) {
        await assertRuntimeEnvironmentCapability(
          target.environmentId,
          WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
          'Update the remote runtime to link Jira'
        )
      }
      const createArgs = pinNewWorkspace ? { ...args, pinOnCreate: true } : args
      const result =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.create(createArgs)
          : await callRuntimeRpc<FolderWorkspaceCreateResult>(
              target,
              'folderWorkspace.create',
              createArgs,
              {
                timeoutMs: args.agentLaunchMode === 'structured' ? 120_000 : 15_000,
                ...(args.agentLaunchMode === 'structured'
                  ? { signal: options.signal ?? new AbortController().signal }
                  : {})
              }
            )
      const workspace = result.folderWorkspace
      const { projectGroups } = get()
      const ownedWorkspace = adoptFromEndpoint(target, {
        kind: 'folderWorkspace',
        row: workspace,
        resolveOwnHostId: (row) => getFolderWorkspaceHostId(row, projectGroups)
      })
      set((s) => ({
        folderWorkspaces: mergeCreatedFolderWorkspace(
          ownedWorkspace,
          selectFolderWorkspaces(s),
          s.projectGroups
        ),
        folderWorkspacePathStatuses: {}
      }))
      holdCreatedSidebarWorkspace({ folderWorkspace: ownedWorkspace })
      if (pinNewWorkspace && !ownedWorkspace.isPinned) {
        let pinned = false
        try {
          pinned = await get().updateFolderWorkspace(
            ownedWorkspace.id,
            { isPinned: true },
            { executionHostId: getFolderWorkspaceHostId(ownedWorkspace, projectGroups) }
          )
        } catch (error) {
          console.error('Failed to pin new folder workspace:', error)
        }
        if (pinned) {
          return { ...result, folderWorkspace: { ...ownedWorkspace, isPinned: true } }
        }
        showWorktreeCreateWarningToast(
          translate(
            'auto.store.slices.worktrees.pinNewWorkspaceFailed',
            'The workspace was created, but could not be pinned.'
          )
        )
      }
      return { ...result, folderWorkspace: ownedWorkspace }
    } catch (err) {
      console.error('Failed to create folder workspace:', err)
      const { title, description } = formatFolderWorkspaceCreateError(err)
      throw new Error(`${title}. ${description}`)
    }
  }
}
