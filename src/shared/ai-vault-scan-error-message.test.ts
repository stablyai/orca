import { describe, expect, it } from 'vitest'
import { describeAiVaultScanError } from './ai-vault-scan-error-message'

describe('describeAiVaultScanError', () => {
  it('replaces the restart-circuit wording with an actionable line', () => {
    expect(describeAiVaultScanError('AI Vault service restart circuit is open.')).toBe(
      'Session scanning paused after repeated failures. Refresh to try again.'
    )
  })

  it('renders the scan timeout in seconds', () => {
    expect(describeAiVaultScanError('AI Vault service timed out after 130000ms.')).toBe(
      'Session scan timed out after 130s — the machine may be busy. Refresh to try again.'
    )
  })

  it('keeps the SSH host in the timeout copy', () => {
    expect(
      describeAiVaultScanError(
        'Agent Session History scan timed out after 130000ms on this SSH host.'
      )
    ).toBe('Session scan timed out after 130s on this SSH host. Refresh to try again.')
  })

  it('humanizes the relay-hosted variant of the same fault', () => {
    expect(describeAiVaultScanError('Relay AI Vault service restart circuit is open.')).toBe(
      'Session scanning paused after repeated failures. Refresh to try again.'
    )
  })

  it('strips the Electron invoke wrapper before matching', () => {
    expect(
      describeAiVaultScanError(
        "Error invoking remote method 'aiVault:listSessions': Error: AI Vault service did not become ready."
      )
    ).toBe('The session scanner stopped unexpectedly. Refresh to try again.')
  })

  it.each([
    ['AI Vault service disconnected.', 'The session scanner stopped unexpectedly.'],
    ['AI Vault service exited (null).', 'The session scanner stopped unexpectedly.'],
    ['AI Vault scanner worker exited with code 1.', 'The session scanner stopped unexpectedly.'],
    ['AI Vault service sent a malformed message.', 'The session scanner stopped unexpectedly.']
  ])('covers the supervision fault %s', (raw, expected) => {
    expect(describeAiVaultScanError(raw)).toBe(`${expected} Refresh to try again.`)
  })

  it('routes a missing scanner entry to install guidance, not a retry', () => {
    const described = describeAiVaultScanError('AI Vault service entry not found: /a/b.js')
    expect(described).toBe(
      'The session scanner is missing from this Orca install. Reinstalling Orca restores it.'
    )
    expect(described).not.toContain('Refresh')
  })

  it('never leaks internal vocabulary a user cannot act on', () => {
    for (const raw of [
      'AI Vault service restart circuit is open.',
      'AI Vault service timed out after 130000ms.',
      'AI Vault service queue is full.',
      'AI Vault service cache invalidation timed out.',
      'AI Vault service did not cancel within 2000ms.',
      'AI Vault service client was disposed.'
    ]) {
      const described = describeAiVaultScanError(raw)
      expect(described).not.toMatch(/circuit|ms\.|AI Vault service|scanner worker/)
    }
  })

  it('passes scanner-authored messages through untouched', () => {
    const authored = 'Could not read /Users/x/.codex/sessions: EACCES'
    expect(describeAiVaultScanError(authored)).toBe(authored)
    expect(describeAiVaultScanError('SSH relay is not ready')).toBe('SSH relay is not ready')
  })

  it('removes transport wrappers before passing through an unknown message', () => {
    expect(
      describeAiVaultScanError(
        "Error invoking remote method 'aiVault:listSessions': Error: SSH relay is not ready"
      )
    ).toBe('SSH relay is not ready')
    expect(describeAiVaultScanError('Relay AI Vault scanner is not ready')).toBe(
      'AI Vault scanner is not ready'
    )
    expect(describeAiVaultScanError('Relay client is not connected')).toBe(
      'Relay client is not connected'
    )
  })
})
