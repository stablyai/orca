import { z } from 'zod'
import { isWorkspaceKey } from '../workspace-scope'
import type { CrossStoreParentRef } from '../worktree/lineage-types'

/** A parent in another Orca store, named by that store's verified installationId. */
export const CrossStoreParentRefSchema: z.ZodType<CrossStoreParentRef> = z.object({
  installationId: z.string().min(1),
  workspaceKey: z.string().refine(isWorkspaceKey, 'Invalid parent workspace key'),
  instanceId: z.string().min(1)
})
