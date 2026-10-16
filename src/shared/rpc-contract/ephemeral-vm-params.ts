import { WorktreeCreate } from './worktree-create-params'
import { z } from 'zod'

const identifier = z.string().trim().min(1).max(256)
export const EphemeralVmRepo = z.object({ repoId: identifier }).strict()
export const EphemeralVmRecipe = EphemeralVmRepo.extend({ recipeId: identifier })
export const EphemeralVmProvision = EphemeralVmRecipe.extend({
  workspaceName: identifier.optional(),
  projectId: identifier.optional(),
  workspaceId: identifier.optional(),
  branch: z.string().max(4096).optional(),
  ref: z.string().max(4096).optional(),
  provisionId: identifier
})
export const EphemeralVmProvisionId = z.object({ provisionId: identifier }).strict()
export const EphemeralVmRuntime = z.object({ runtimeId: identifier }).strict()
export const EphemeralVmWorkspace = z.object({ workspaceId: identifier }).strict()
export const EphemeralVmAttach = EphemeralVmRuntime.extend({ workspaceId: identifier })

export const EphemeralVmProvisionWorkspace = EphemeralVmProvision.extend({
  projectId: identifier,
  workspaceName: identifier,
  workspaceRequest: WorktreeCreate
})
export const EphemeralVmAdopt = WorktreeCreate.safeExtend({
  repo: z.string().default('provisioned-root'),
  repoId: identifier,
  name: identifier,
  runtimeId: identifier,
  expectedPath: z.string().min(1),
  expectedRefHead: z.string().optional(),
  executionHostId: z.string().optional()
})
