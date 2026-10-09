import type { SecretAtRestProtection } from './secret-at-rest-protection'
export type BitbucketAuthMode = 'token' | 'basic'

// Where the active credential comes from. Drives whether the UI offers
// Disconnect, which is only meaningful for in-app `stored` credentials.
export type BitbucketCredentialSource = 'environment' | 'stored' | 'none'

export type BitbucketConnectArgs = {
  authMode: BitbucketAuthMode
  accessToken?: string | null
  email?: string | null
  apiToken?: string | null
  baseUrl?: string | null
}

// Deliberately excludes the secret: it never crosses the IPC boundary back to
// the renderer.
export type BitbucketConnectionStatus = {
  configured: boolean
  /**
   * How a `stored` credential sits on disk. Null for `environment` and `none`: Orca
   * wrote nothing, so it has no claim to make. Optional so an older remote host that
   * omits it reads as unknown rather than as sealed.
   */
  credentialProtection?: SecretAtRestProtection | null
  source: BitbucketCredentialSource
  account: string | null
  authMode: BitbucketAuthMode | null
  email: string | null
  baseUrl: string | null
}

export type BitbucketConnectResult =
  | { ok: true; account: string | null }
  | { ok: false; error: string }
