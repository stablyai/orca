import { z } from 'zod'
import type { TabFolderGroup } from './tab-folder-types'

export const tabFolderGroupSchema: z.ZodType<TabFolderGroup> = z.object({
  id: z.string(),
  worktreeId: z.string(),
  splitGroupId: z.string(),
  name: z.string(),
  color: z.string(),
  collapsed: z.boolean(),
  tabOrder: z.array(z.string()),
  sortOrder: z.number(),
  createdAt: z.number()
})
