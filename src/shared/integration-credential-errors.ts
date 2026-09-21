export type IntegrationCredentialService = 'Linear' | 'Jira' | 'Bitbucket'

export function credentialDecryptionMessage(service: IntegrationCredentialService): string {
  return `Could not decrypt saved ${service} credential. Approve Keychain access or reconnect ${service}.`
}

// Why: decrypt errors cross IPC/RPC boundaries where only the message
// survives serialization, so detection matches on the canonical message.
export function isIntegrationCredentialDecryptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(credentialDecryptionMessage('Linear')) ||
    message.includes(credentialDecryptionMessage('Jira')) ||
    message.includes(credentialDecryptionMessage('Bitbucket'))
  )
}
