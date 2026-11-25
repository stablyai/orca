import { z } from 'zod'

// Why trimmed: the stores trim before saving, so a blank paste must fail here, not as "required".
// Why bounded: a pasted value larger than any real key or Cookie header is a mistake, not a credential.
export const UsageCredentialApiKeyParams = z.strictObject({
  apiKey: z.string().trim().min(1).max(4_096)
})

export const UsageCredentialSessionCookieParams = z.strictObject({
  cookie: z.string().trim().min(1).max(65_536)
})
