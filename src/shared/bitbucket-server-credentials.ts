import type { SecretAtRestProtection } from './secret-at-rest-protection'

export type BitbucketServerCredentialSource = 'environment' | 'stored' | 'none'

export type BitbucketServerConnectArgs = {
  baseUrl: string
  accessToken: string
}

// Deliberately excludes the token: it never crosses the IPC boundary back to the renderer.
export type BitbucketServerConnectionStatus = {
  configured: boolean
  source: BitbucketServerCredentialSource
  credentialProtection?: SecretAtRestProtection | null
  account: string | null
  baseUrl: string | null
}

export type BitbucketServerConnectResult =
  | { ok: true; account: string | null }
  | { ok: false; error: string }
