import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inMemoryMain,
  SSH_HOST,
  SSH_REPO,
  windowSavingTo
} from './desktop-relay-writes.test-fixture'
import {
  probeDesktopRelays,
  replaceDesktopRelays,
  sendDesktopRelayWrite,
  takeDesktopRelayWrite
} from './desktop-relay-writes'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'

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

  it('clears that relay after its fenced partition opens again', async () => {
    const main = inMemoryMain()
    const { stop, endRelay, renameTab } = await windowSavingTo(main, { parked: true })
    try {
      main.fenced.add(SSH_HOST)
      await endRelay()
      main.fenced.delete(SSH_HOST)

      await renameTab('renamed')

      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('clears an ended relay main stored from a write it partly refused', async () => {
    const main = inMemoryMain()
    // Main holds another id for tab-b, so the window's first write there is refused for that tab.
    main.partitions.set(SSH_HOST, {
      ...main.stored(SSH_HOST),
      remoteSessionIdsByTabId: { 'tab-b': 'relay-main' }
    })
    const { stop, endRelay } = await windowSavingTo(main, { parked: true, secondTab: true })
    try {
      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({
        'tab-a': 'relay-a',
        'tab-b': 'relay-main'
      })

      await endRelay()

      expect(main.stored(SSH_HOST).remoteSessionIdsByTabId).toEqual({ 'tab-b': 'relay-main' })
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

  it('names a relay that ended while its save was unanswered when the window quits', async () => {
    const api = {
      desktopRelaysVersion: async () => 1,
      // Main stores the write but its answer never arrives before quit.
      applyDesktopRelays: () => new Promise<never>(() => {})
    }
    probeDesktopRelays(api)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay write reads tab ids only.
    const parked = {
      tabsByWorktree: { 'other::/p': [{ id: 'tab-p' }] }
    } as unknown as WorkspaceSessionState
    const state = { repos: [SSH_REPO], contestedHostWorkspaceSessions: { [SSH_HOST]: parked } }
    const slice = (relays: Record<string, string>) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay write reads relay ids only.
      ({ [SSH_HOST]: { remoteSessionIdsByTabId: relays } as WorkspaceSessionState })
    void sendDesktopRelayWrite(api, takeDesktopRelayWrite(slice({ 'tab-a': 'relay-a' }), state))

    const quit = replaceDesktopRelays(slice({}), state)

    expect(quit.hosts.find((host) => host.hostId === SSH_HOST)?.removedTabIds).toEqual(['tab-a'])
  })
})
