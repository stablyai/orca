import { z } from 'zod'

export const ZotzAgentQueueSnapshotParams = z.object({})

export const ZotzAgentQueueSubscribeParams = z.object({})

// Same bound the window IPC applies to a task id.
export const ZotzAgentQueueTaskParams = z.object({ id: z.string().min(1).max(1024) })
