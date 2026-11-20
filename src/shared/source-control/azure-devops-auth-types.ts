export type AzureDevOpsAuthMethod = 'environment' | 'azure-cli'

export type AzureDevOpsCredentialState =
  | 'not-configured'
  | 'credential-ready'
  | 'authenticated'
  | 'error'

export type AzureDevOpsAuthErrorCode =
  | 'cli-not-installed'
  | 'login-required'
  | 'token-acquisition-failed'
  | 'cli-timeout'
  | 'invalid-token-response'
  | 'unsupported-endpoint'
  | 'unauthorized'
  | 'forbidden'
  | 'network-error'

export type AzureDevOpsAuthStatus = {
  configured: boolean
  authenticated: boolean
  account: string | null
  baseUrl: string | null
  tokenConfigured: boolean
  authMethod?: AzureDevOpsAuthMethod
  credentialState?: AzureDevOpsCredentialState
  credentialAvailable?: boolean
  errorCode?: AzureDevOpsAuthErrorCode
}

export function normalizeAzureDevOpsAuthMethod(value: unknown): AzureDevOpsAuthMethod {
  return value === 'azure-cli' ? 'azure-cli' : 'environment'
}
