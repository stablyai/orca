import { describe, expect, it } from 'vitest'
import { hermesAcpLoadSessionId, hermesResumeSessionId } from './hermes-session-id'

const TIMESTAMP_ID = '20261031_144415_71256d'
const UUID_ID = '11111111-1111-4111-8111-111111111111'

describe('hermesResumeSessionId', () => {
  it('keeps a timestamp or uuid hook id', () => {
    expect(hermesResumeSessionId(TIMESTAMP_ID)).toBe(TIMESTAMP_ID)
    expect(hermesResumeSessionId(`  ${UUID_ID}  `)).toBe(UUID_ID)
  })

  it('rejects titles, latest, and empty values', () => {
    expect(hermesResumeSessionId('latest')).toBeNull()
    expect(hermesResumeSessionId('my-chat')).toBeNull()
    expect(hermesResumeSessionId('')).toBeNull()
    expect(hermesResumeSessionId(undefined)).toBeNull()
  })

  it('loads a Hermes ACP uuid and not a TUI timestamp', () => {
    expect(hermesAcpLoadSessionId('hermes', { providerSessionId: UUID_ID })).toBe(UUID_ID)
    expect(hermesAcpLoadSessionId('hermes', { providerSessionId: TIMESTAMP_ID })).toBeNull()
    expect(hermesAcpLoadSessionId('hermes', { providerSessionId: 'provider-1' })).toBeNull()
    expect(hermesAcpLoadSessionId('claude', { providerSessionId: UUID_ID })).toBeNull()
    expect(hermesAcpLoadSessionId('hermes', undefined)).toBeNull()
  })
})
