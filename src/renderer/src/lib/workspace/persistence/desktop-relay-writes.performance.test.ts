import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inMemoryMain, SSH_HOST, windowSavingTo } from './desktop-relay-writes.test-fixture'

// Perf contract: a terminal save rebuilds every host's relay ids, but the window sends main only the
// hosts and ids that changed since main last accepted them.

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('sends no relay host for a title change and one id for one relay change', async () => {
  const main = inMemoryMain()
  const { stop, endRelay, renameTab } = await windowSavingTo(main)
  try {
    main.sentHosts.length = 0

    await renameTab('renamed')
    expect(main.sentHosts).toEqual([])

    await endRelay()
    expect(main.sentHosts).toEqual([
      [{ hostId: SSH_HOST, relayIdsByTabId: {}, removedTabIds: ['tab-a'] }]
    ])
  } finally {
    stop()
  }
})
