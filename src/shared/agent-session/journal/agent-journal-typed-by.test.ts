import { describe, expect, it } from 'vitest'
import { personTypistOf, typistOtherThanViewer } from './agent-journal-typed-by'

// A teammate typed on their own computer; the host (the owner's) compared it with its own account.
const typist = personTypistOf({
  by: 'device',
  deviceId: 'device-g16',
  account: 'teammate@example.com',
  accountId: 'acct-teammate',
  own: false,
  computer: 'g16'
})

describe('typistOtherThanViewer', () => {
  it('labels a teammate’s message on the host, never on the teammate’s own computer', () => {
    expect(typistOtherThanViewer(typist, 'acct-owner')).toEqual({
      name: 'teammate@example.com',
      accountId: 'acct-teammate',
      own: false,
      computer: 'g16'
    })
    expect(typistOtherThanViewer(typist, 'acct-teammate')).toBeUndefined()
  })

  it('falls back to the host’s comparison for a viewer with no account, where unknown is not other', () => {
    expect(typistOtherThanViewer(typist, null)?.accountId).toBe('acct-teammate')
    const hostUnsure = personTypistOf({
      by: 'device',
      deviceId: 'd',
      account: 'Sam',
      accountId: 'acct-sam'
    })
    expect(typistOtherThanViewer(hostUnsure, null)).toBeUndefined()
  })
})
