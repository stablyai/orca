import { z } from 'zod'
import {
  MULTI_REPO_WORKSPACE_MAX_MEMBERS,
  MULTI_REPO_WORKSPACE_MIN_MEMBERS
} from '../multi-repo-workspace'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { OptionalTuiAgent } from './worktree-params'

// `placement` and any directory are deliberately absent: the host derives every path.
export const MultiRepoWorkspaceCreate = z.object({
  name: requiredString('Missing workspace name'),
  members: z
    .array(
      z.object({
        repoId: requiredString('Missing project id'),
        branchName: OptionalString,
        baseRef: OptionalString
      })
    )
    .min(MULTI_REPO_WORKSPACE_MIN_MEMBERS, 'A multi-repo workspace needs at least 2 projects')
    .max(MULTI_REPO_WORKSPACE_MAX_MEMBERS, 'Too many projects in one workspace'),
  clientMutationId: z.string().min(1).max(128).optional(),
  createdWithAgent: OptionalTuiAgent
})

export const MultiRepoWorkspaceSelector = z.object({
  folderWorkspaceId: requiredString('Missing folder workspace id')
})

export const MultiRepoWorkspaceMemberSelector = MultiRepoWorkspaceSelector.extend({
  memberId: requiredString('Missing member id')
})

export const MultiRepoWorkspaceDelete = MultiRepoWorkspaceSelector.extend({
  // Force is scoped per member; the host rejects ids that are not members.
  forceMemberIds: z.array(z.string().min(1)).max(MULTI_REPO_WORKSPACE_MAX_MEMBERS).optional(),
  allowFailedArchiveHookMemberIds: z
    .array(z.string().min(1))
    .max(MULTI_REPO_WORKSPACE_MAX_MEMBERS)
    .optional(),
  runHooks: OptionalBoolean
})
