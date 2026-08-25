import { describe, expect, it } from 'vitest'
import {
  isTerminalOwnerIdentity,
  sameTerminalOwnerIdentity,
  type TerminalOwnerIdentity
} from './terminal-owner-identity'

const identity: TerminalOwnerIdentity = {
  executionHostId: 'local',
  ownerKind: 'daemon',
  ownerIncarnationId: 'daemon-a',
  sessionIncarnationId: 'session-1',
  protocolVersion: 37,
  endpointRef: 'local-daemon'
}

describe('terminal owner identity', () => {
  it('requires the complete owner/session tuple', () => {
    expect(isTerminalOwnerIdentity(identity)).toBe(true)
    expect(isTerminalOwnerIdentity({ ...identity, ownerIncarnationId: '' })).toBe(false)
    expect(isTerminalOwnerIdentity({ ...identity, protocolVersion: 0 })).toBe(false)
    expect(isTerminalOwnerIdentity({ ...identity, ownerKind: 'unknown' })).toBe(false)
  })

  it('does not treat a replacement owner as the same authority', () => {
    expect(
      sameTerminalOwnerIdentity(identity, { ...identity, ownerIncarnationId: 'daemon-b' })
    ).toBe(false)
    expect(sameTerminalOwnerIdentity(identity, { ...identity })).toBe(true)
  })
})
