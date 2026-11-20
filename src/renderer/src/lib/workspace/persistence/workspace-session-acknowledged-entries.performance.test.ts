import { expect, it } from 'vitest'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'

// Perf contract (#45731): a title acknowledgement copied every supplied fleet map, changed or not.

/** A fleet-sized record that counts how often its keys are listed (a copy lists them). */
function countedFleetRecord(size: number) {
  const counts = { listings: 0 }
  const record = Object.fromEntries(Array.from({ length: size }, (_, i) => [`w${i}`, `g${i}`]))
  const counted = new Proxy(record, {
    ownKeys: (target) => {
      counts.listings += 1
      return Reflect.ownKeys(target)
    }
  })
  return { counted, counts }
}

function keyedAcknowledgementListings(size: number) {
  const acknowledged = new AcknowledgedWorkspaceSessionEntries()
  const { counted, counts } = countedFleetRecord(size)
  acknowledged.diff('local', { tabGroups: counted, tabsByWorktree: { w0: 'old' } }).acknowledge()
  counts.listings = 0
  acknowledged
    .diffEntries('local', { tabGroups: { w0: 'g0' }, tabsByWorktree: { w0: 'new' } })
    ?.acknowledge()
  const next = acknowledged.diffEntries('local', { tabsByWorktree: { w0: 'new' } })
  return { listings: counts.listings, resent: next?.patch }
}

it.each([1900, 19000])(
  'a keyed acknowledgement copies no unchanged field at %i workspaces',
  (size) => {
    expect(keyedAcknowledgementListings(size)).toEqual({
      listings: 0,
      resent: { fields: {}, entries: {} }
    })
  }
)
