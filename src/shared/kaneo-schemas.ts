import { z } from 'zod'

export const KaneoConnectSchema = z.object({
  siteUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().min(1).max(8192)
})
export const KaneoTaskUrlSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  requestId: z.string().min(1).max(100).optional()
})
