import { z } from 'zod'
import { TAB_CLUSTER_COLORS } from './tab-types'

const tabClusterSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(TAB_CLUSTER_COLORS).catch('grey'),
  collapsed: z.boolean(),
  tabIds: z.array(z.string()),
  shownTabId: z.string().optional().catch(undefined)
})

export const tabGroupSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  activeTabId: z.string().nullable(),
  tabOrder: z.array(z.string()),
  recentTabIds: z.array(z.string()).optional(),
  tabClusters: z.array(tabClusterSchema).optional().catch(undefined)
})
