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

export type BitbucketConnectResult =
  | { ok: true; account: string | null }
  | { ok: false; error: string }
