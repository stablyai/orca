import { z } from 'zod'

const AccessRequest = z.object({
  selector: z.string().trim().min(1).max(1024),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
})

export const RuntimeSshAccessLinkRequestSchema = AccessRequest.extend({
  sshTargetId: z.string().trim().min(1).max(1024),
  remotePort: z.number().int().min(1).max(65_535)
}).strict()
export const RuntimeSshAccessUnlinkRequestSchema = AccessRequest.strict()

export type RuntimeSshAccessLinkRequest = z.infer<typeof RuntimeSshAccessLinkRequestSchema>
export type RuntimeSshAccessUnlinkRequest = z.infer<typeof RuntimeSshAccessUnlinkRequestSchema>
