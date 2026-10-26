import { describe, expect, it, vi } from 'vitest'
import { sshConnectingLabel, sshConnectVerb } from './ssh-connect-verb'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// One shared vocabulary keeps simultaneous sidebar/pane/header/status controls consistent.
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
