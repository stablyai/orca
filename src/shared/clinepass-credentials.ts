export type ClinePassCredentialsSource = 'stored' | 'environment' | 'none'

export type ClinePassCredentialsStatus = {
  configured: boolean
  source: ClinePassCredentialsSource
}
