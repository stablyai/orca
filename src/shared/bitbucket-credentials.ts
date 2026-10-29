import type { SecretAtRestProtection } from './secret-at-rest-protection'
export type BitbucketAuthMode = 'token' | 'basic'

// Offer Disconnect only for in-app stored credentials.
export type BitbucketCredentialSource = 'environment' | 'stored' | 'none'

export type BitbucketConnectArgs = {
  authMode: BitbucketAuthMode
  accessToken?: string | null
  email?: string | null
  apiToken?: string | null
  baseUrl?: string | null
}

// Never return credential secrets over IPC to the renderer.
export type BitbucketConnectionStatus = {
  configured: boolean
  /** Stored-at-rest status only; environment/none write nothing and use null. Older hosts omit this, meaning unknown rather than sealed. */
  credentialProtection?: SecretAtRestProtection | null
  source: BitbucketCredentialSource
  account: string | null
  authMode: BitbucketAuthMode | null
  email: string | null
  baseUrl: string | null
}

// One English table for Bitbucket connect failures: main builds the wire `error`, the renderer translates by code.
export const BITBUCKET_CONNECT_FAILURE_COPY = {
  invalidInput: 'Invalid Bitbucket credentials',
  accessTokenRequired: 'Enter an access token.',
  emailAndApiTokenRequired: 'Enter both an email and an API token.',
  rejected: 'Bitbucket rejected these credentials. Check the email and token, then try again.',
  unreachable:
    'Could not reach Bitbucket. Check your connection or the API base URL, then try again.'
} as const

export type BitbucketConnectFailureCode = keyof typeof BITBUCKET_CONNECT_FAILURE_COPY

export type BitbucketConnectResult =
  | { ok: true; account: string | null }
  /** `error` stays English for older clients; `errorCode` is absent from older hosts. */
  | { ok: false; error: string; errorCode?: string }

export function bitbucketConnectFailure(
  errorCode: BitbucketConnectFailureCode
): Extract<BitbucketConnectResult, { ok: false }> {
  return { ok: false, error: BITBUCKET_CONNECT_FAILURE_COPY[errorCode], errorCode }
}
