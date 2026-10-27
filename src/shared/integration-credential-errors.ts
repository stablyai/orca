export type IntegrationCredentialService = 'Linear' | 'Jira' | 'Bitbucket'

export function credentialDecryptionMessage(service: IntegrationCredentialService): string {
  return `Could not decrypt saved ${service} credential. Approve Keychain access or reconnect ${service}.`
}

// IPC/RPC may preserve only error messages; detect the canonical decrypt-failure text.
export function isIntegrationCredentialDecryptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(credentialDecryptionMessage('Linear')) ||
    message.includes(credentialDecryptionMessage('Jira')) ||
    message.includes(credentialDecryptionMessage('Bitbucket'))
  )
}
