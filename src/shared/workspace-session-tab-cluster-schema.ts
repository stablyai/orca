import { z } from 'zod'
import { TAB_CLUSTER_COLORS } from './tab-types'

export const tabClusterSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(TAB_CLUSTER_COLORS).catch('grey'),
  collapsed: z.boolean(),
  tabIds: z.array(z.string()),
  shownTabId: z.string().optional().catch(undefined)
})
