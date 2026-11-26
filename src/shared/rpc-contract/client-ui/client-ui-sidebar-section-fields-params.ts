import { z } from 'zod'
import { WORKSPACE_GROUP_BY_VALUES } from '../../workspace-view/workspace-group-by'

/** How the sidebar groups workspaces and orders project and tag sections. */
export const ClientUiSidebarSectionFields = {
  groupBy: z.enum(WORKSPACE_GROUP_BY_VALUES).optional(),
  tagOrderBy: z.enum(['name', 'manual', 'activity']).optional(),
  manualRepoOrder: z
    .array(z.object({ hostId: z.string(), repoId: z.string() }).strict())
    .optional(),
  manualTagOrder: z.array(z.string()).optional()
}
