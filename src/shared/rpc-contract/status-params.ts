import { z } from 'zod'

export const StatusGet = z.object({ includeRemoteServer: z.boolean().optional() }).optional()
