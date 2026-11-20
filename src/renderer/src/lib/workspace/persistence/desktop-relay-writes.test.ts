import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inMemoryMain,
  SSH_HOST,
  SSH_REPO,
  windowSavingTo
} from './desktop-relay-writes.test-fixture'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('relay ids saved by ownership', () => {
  it('clears the last SSH relay that ended, keeping one main saved for another tab', async () => {
    const main = inMemoryMain()
    const { stop, endRelay } = await windowSavingTo(main)
    try {
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })
      main.partitions.set(SSH_HOST, {
        ...main.stored(SSH_HOST),
        remoteSessionIdsByTabId: { 'tab-a': 'relay-a', 'tab-b': 'relay-b' }
      })

      await endRelay()

      // A crash now restarts from this partition.
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-b': 'relay-b' })
    } finally {
      stop()
    }
  })

  it("keeps a host's relay ids when its worktree listing hasn't arrived yet", async () => {
    const main = inMemoryMain()
    const { stop } = await windowSavingTo(main, { listed: false })
    try {
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })
    } finally {
      stop()
    }
  })

  it('saves relay ids for a repo that names its SSH host only by execution host', async () => {
    const main = inMemoryMain()
    const repo = { ...SSH_REPO, connectionId: null, executionHostId: SSH_HOST }
    const { stop } = await windowSavingTo(main, { repo })
    try {
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })
    } finally {
      stop()
    }
  })

  it('clears an ended relay the window wrote on a host holding a parked workspace', async () => {
    const main = inMemoryMain()
    const { stop, endRelay } = await windowSavingTo(main, { parked: true })
    try {
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })

      await endRelay()

      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('clears it after a fenced partition opens again', async () => {
    const main = inMemoryMain()
    const { stop, endRelay, renameTab } = await windowSavingTo(main)
    try {
      main.fenced.add(SSH_HOST)
      await endRelay()
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'relay-a' })
      main.fenced.delete(SSH_HOST)

      await renameTab('renamed')

      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toBeUndefined()
    } finally {
      stop()
    }
  })
})
