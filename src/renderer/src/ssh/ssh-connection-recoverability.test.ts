import { describe, expect, it } from 'vitest'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import { canConnectSshStatus, isConnectingSshStatus } from './ssh-connection-recoverability'

// Union growth is caught by the typechecker (the modules use total Records), not here.
// These cases pin the classification itself, which four call sites now depend on.
const ALL_STATUSES: SshConnectionStatus[] = [
  'disconnected',
  'connecting',
  'auth-failed',
  'deploying-relay',
  'connected',
  'reconnecting',
  'reconnection-failed',
  'error'
]

describe('isConnectingSshStatus', () => {
  it.each(['connecting', 'deploying-relay', 'reconnecting'] as const)(
    'treats %s as an attempt already under way',
    (status) => {
      expect(isConnectingSshStatus(status)).toBe(true)
    }
  )

  it.each(['disconnected', 'auth-failed', 'connected', 'reconnection-failed', 'error'] as const)(
    'does not treat %s as connecting',
    (status) => {
      expect(isConnectingSshStatus(status)).toBe(false)
    }
  )
})

describe('canConnectSshStatus', () => {
  it.each(['disconnected', 'auth-failed', 'reconnection-failed', 'error'] as const)(
    'offers a user-driven connect for %s',
    (status) => {
      expect(canConnectSshStatus(status)).toBe(true)
    }
  )

  it.each(['connecting', 'deploying-relay', 'reconnecting', 'connected'] as const)(
    'withholds connect for %s',
    (status) => {
      expect(canConnectSshStatus(status)).toBe(false)
    }
  )
})

// Why: runtime-owned targets deliberately yield a null status. Both predicates must read
// that as "nothing to offer" so the card falls through to the passive host glyph.
describe('absent status', () => {
  it.each([null, undefined])('classifies %s as neither connecting nor connectable', (status) => {
    expect(isConnectingSshStatus(status)).toBe(false)
    expect(canConnectSshStatus(status)).toBe(false)
  })
})

describe('the two predicates together', () => {
  it('never claims a status is both connecting and connectable', () => {
    for (const status of ALL_STATUSES) {
      expect(isConnectingSshStatus(status) && canConnectSshStatus(status)).toBe(false)
    }
  })

  it('leaves only connected outside both sets, so no state renders a dead control', () => {
    const unclassified = ALL_STATUSES.filter(
      (status) => !isConnectingSshStatus(status) && !canConnectSshStatus(status)
    )
    expect(unclassified).toEqual(['connected'])
  })
})
