import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A remote caller's base URL receives the credential, so it must be https (plain http only to loopback). */
export function isAllowedBitbucketBaseUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    // Blank means the default Bitbucket Cloud API.
    return true
  }
  try {
    const url = new URL(trimmed)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname))
    )
  } catch {
    return false
  }
}

// Same shape as the desktop bitbucket:connect IPC; the host verifies and trims before saving.
export const BitbucketConnectParams = lazyZodSchema(() => {
  // Why bounded: a pasted value larger than any real token or URL is a mistake, not a credential.
  const optionalField = z.string().max(4_096).nullable().optional()
  return z.object({
    authMode: z.enum(['token', 'basic']),
    accessToken: optionalField,
    email: optionalField,
    apiToken: optionalField,
    baseUrl: optionalField.refine(
      (value) => value == null || isAllowedBitbucketBaseUrl(value),
      'Bitbucket API base URL must use https.'
    )
  })
})
