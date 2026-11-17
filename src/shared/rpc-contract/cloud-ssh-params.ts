import { z } from 'zod'

/** An Orca Cloud workspace by name, SSH host name, or id. */
export const CloudSshParams = z.object({
  workspace: z.string().trim().min(1, 'Missing workspace').max(256)
})
