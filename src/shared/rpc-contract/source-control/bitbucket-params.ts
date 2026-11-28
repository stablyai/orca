import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Same shape as the desktop bitbucket:connect IPC; the host verifies and trims before saving.
export const BitbucketConnectParams = lazyZodSchema(() => {
  // Why bounded: a pasted value larger than any real token or URL is a mistake, not a credential.
  const optionalField = z.string().max(4_096).nullable().optional()
  return z.object({
    authMode: z.enum(['token', 'basic']),
    accessToken: optionalField,
    email: optionalField,
    apiToken: optionalField,
    baseUrl: optionalField
  })
})
