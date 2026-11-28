// Which picks a username check still out can hold back: only a check that could change who the
// pick is. Synthetic ids and logins only.
import { describe, expect, it } from 'vitest'
import { WhoCanAskIdentityLedger } from './who-can-ask-identity-ledger'
import { heldPicks } from './who-can-ask-picks'

const pick = { id: '2', name: 'sam' }
const holder = (id: string, name: string) => [{ id, name }]

describe('a pick held by a username check still out', () => {
  it('is not held by an older check of a login it was once known by', () => {
    const ledger = new WhoCanAskIdentityLedger()
    ledger.settle(ledger.issue('mori'), 'mori', holder('2', 'mori'))
    // Another `mori` check goes out, then a newer `sam` check names id 2 as `sam`.
    ledger.issue('mori')
    const sam = ledger.issue('sam')
    ledger.settle(sam, 'sam', holder('2', 'sam'))
    expect(heldPicks([pick], [pick], {}, ledger)).toEqual([])
  })

  it('is held by a matching check asked after the one that named it', () => {
    const ledger = new WhoCanAskIdentityLedger()
    ledger.settle(ledger.issue('mori'), 'mori', holder('2', 'mori'))
    ledger.settle(ledger.issue('sam'), 'sam', holder('2', 'sam'))
    ledger.issue('mori')
    expect(heldPicks([pick], [pick], {}, ledger)).toEqual([pick])
  })

  it('is held by any matching check while no check has named it', () => {
    const ledger = new WhoCanAskIdentityLedger()
    ledger.issue('sam')
    expect(heldPicks([pick], [pick], {}, ledger)).toEqual([pick])
  })

  it('is not held by a check that matches nothing it is known by', () => {
    const ledger = new WhoCanAskIdentityLedger()
    ledger.issue('lee')
    expect(heldPicks([pick], [pick], {}, ledger)).toEqual([])
  })
})
