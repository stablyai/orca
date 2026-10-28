import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type {
  MultiRepoDeleteInspection,
  MultiRepoDeleteResult
} from '../../../../../shared/multi-repo-workspace'
import type { MultiRepoWorkspaceCreateArgs } from './multi-repo-workspace-transport'

export type MultiRepoMemberAction = 'retryMember' | 'removeMember' | 'detachMember' | 'attachMember'

export type MultiRepoWorkspaceSlice = {
  createMultiRepoWorkspace: (args: MultiRepoWorkspaceCreateArgs) => Promise<FolderWorkspace>
  runMultiRepoMemberAction: (
    action: MultiRepoMemberAction,
    args: { folderWorkspaceId: string; memberId: string; executionHostId?: ExecutionHostId }
  ) => Promise<FolderWorkspace>
  inspectMultiRepoWorkspaceDelete: (args: {
    folderWorkspaceId: string
    executionHostId?: ExecutionHostId
  }) => Promise<MultiRepoDeleteInspection>
  deleteMultiRepoWorkspace: (args: {
    folderWorkspaceId: string
    executionHostId?: ExecutionHostId
    forceMemberIds?: string[]
    allowFailedArchiveHookMemberIds?: string[]
    runHooks?: boolean
  }) => Promise<MultiRepoDeleteResult>
}
