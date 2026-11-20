import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inMemoryMain, SSH_HOST, windowSavingTo } from './desktop-relay-writes.test-fixture'

// Perf contract: a terminal save rebuilds every host's relay ids, but the window sends main only the
// hosts and ids that changed since main last accepted them, with the host's entries patch so main
// publishes the save once.

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('sends no relay host for a title change and one id, with its entries, for one relay change', async () => {
  const main = inMemoryMain()
  const { stop, endRelay, renameTab } = await windowSavingTo(main)
  try {
    main.sentHosts.length = 0

    await renameTab('renamed')
    expect(main.sentHosts).toEqual([])

    await endRelay()
    expect(main.sentHosts).toEqual([
      [{ hostId: SSH_HOST, relayIdsByTabId: {}, removedTabIds: ['tab-a'], via: 'entries' }]
    ])
  } finally {
    stop()
  }
})

it('names an ended relay once on a host whose other tab main keeps refusing', async () => {
  const main = inMemoryMain()
  main.partitions.set(SSH_HOST, {
    ...main.stored(SSH_HOST),
    remoteSessionIdsByTabId: { 'tab-b': 'relay-main' }
  })
  const { stop, endRelay, renameTab } = await windowSavingTo(main, {
    parked: true,
    secondTab: true
  })
  try {
    await endRelay('tab-a')
    main.sentHosts.length = 0

    await renameTab('renamed')

    expect(main.sentHosts.flat().flatMap((host) => host.removedTabIds ?? [])).toEqual([])
  } finally {
    stop()
  }
})

it("carries a full save's changed relay with that host's snapshot", async () => {
  const main = inMemoryMain()
  const { stop, dropRelay, durableSave } = await windowSavingTo(main)
  try {
    main.sentHosts.length = 0
    dropRelay()

    await durableSave()

    // Main applies each host's relay ids in the same publish as its snapshot.
    expect(main.sentHosts.flat().map(({ via }) => via)).not.toContain('separate')
    expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toBeUndefined()
  } finally {
    stop()
  }
})
