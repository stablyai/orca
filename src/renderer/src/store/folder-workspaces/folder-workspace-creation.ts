import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type { FolderWorkspaceCreateResult } from '../../../../shared/folder-workspaces/folder-workspace-create'
import { assertWorkspaceAttachmentWriteCapability } from '../../runtime/workspace-links/runtime-workspace-attachment-capabilities'
import { assertLinkedWorkItemContextCapability } from '../../lib/work-items/linked-work-item-capability'
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
      // Why: a new folder has no row yet, so creation goes to the host the caller picked.
      const target = runtimeTargetForOwnerEnvironment(options.runtimeEnvironmentId)
      await assertWorkspaceAttachmentWriteCapability(target, args)
      await assertLinkedWorkItemContextCapability(target, [
        args.linkedTask?.provider,
        args.linkedTaskSourceContext?.provider
      ])
      const result =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.create(args)
          : await callRuntimeRpc<FolderWorkspaceCreateResult>(
              target,
              'folderWorkspace.create',
              args,
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
      return { ...result, folderWorkspace: ownedWorkspace }
    } catch (err) {
      console.error('Failed to create folder workspace:', err)
      const { title, description } = formatFolderWorkspaceCreateError(err)
      throw new Error(`${title}. ${description}`)
    }
  }
}
