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
  source: BitbucketCredentialSource
  account: string | null
  authMode: BitbucketAuthMode | null
  email: string | null
  baseUrl: string | null
}

export type BitbucketConnectResult =
  | { ok: true; account: string | null }
  | { ok: false; error: string }
