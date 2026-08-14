import { describe, expect, it, vi } from 'vitest'
import { sshConnectingLabel, sshConnectVerb } from './ssh-connect-verb'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Why: the sidebar card control, terminal overlay, host-header menu, and status-bar row all
// read this table. It is the only thing keeping them from naming one click three ways.
describe('sshConnectVerb', () => {
  it('names an authentication failure a reconnect', () => {
    expect(sshConnectVerb('auth-failed')).toBe('Reconnect')
  })

  it.each(['error', 'reconnection-failed'] as const)('names %s a retry', (status) => {
    expect(sshConnectVerb(status)).toBe('Retry')
  })

  it.each(['disconnected', 'connecting', 'deploying-relay', 'reconnecting', 'connected'] as const)(
    'falls back to Connect for %s',
    (status) => {
      expect(sshConnectVerb(status)).toBe('Connect')
    }
  )

  it.each([null, undefined])('falls back to Connect for %s', (status) => {
    expect(sshConnectVerb(status)).toBe('Connect')
  })
})

describe('sshConnectingLabel', () => {
  it('uses the single-character ellipsis, matching the rest of the catalog', () => {
    expect(sshConnectingLabel()).toBe('Connecting…')
  })
})
