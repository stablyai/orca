import { describe, expect, it } from 'vitest'
import {
  INTEGRATION_CREDENTIAL_SERVICES,
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from './integration-credential-errors'

describe('integration credential services', () => {
  it('keeps the existing Linear/Jira/Bitbucket messages byte-for-byte', () => {
    expect(credentialDecryptionMessage('Linear')).toBe(
      'Could not decrypt saved Linear credential. Approve Keychain access or reconnect Linear.'
    )
    expect(credentialDecryptionMessage('Jira')).toBe(
      'Could not decrypt saved Jira credential. Approve Keychain access or reconnect Jira.'
    )
    expect(credentialDecryptionMessage('Bitbucket')).toBe(
      'Could not decrypt saved Bitbucket credential. Approve Keychain access or reconnect Bitbucket.'
    )
  })

  it('produces the same message shape for the Kanban service', () => {
    expect(credentialDecryptionMessage('Kanban')).toBe(
      'Could not decrypt saved Kanban credential. Approve Keychain access or reconnect Kanban.'
    )
  })

  it('recognizes decrypt failures for every declared service', () => {
    for (const service of INTEGRATION_CREDENTIAL_SERVICES) {
      expect(
        isIntegrationCredentialDecryptionError(new Error(credentialDecryptionMessage(service)))
      ).toBe(true)
      expect(isIntegrationCredentialDecryptionError(credentialDecryptionMessage(service))).toBe(
        true
      )
    }
  })

  it('derives the detection set from the single source of truth', () => {
    expect(INTEGRATION_CREDENTIAL_SERVICES).toEqual(['Linear', 'Jira', 'Bitbucket', 'Kanban'])
  })

  it('does not match unrelated errors', () => {
    expect(isIntegrationCredentialDecryptionError(new Error('boom'))).toBe(false)
    expect(isIntegrationCredentialDecryptionError('plain text')).toBe(false)
  })
})
