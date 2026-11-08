import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalProviderSnapshotCapabilities,
  markTerminalProviderSessionAlive,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderSessionIsGone
} from './terminal-provider-snapshot-capability'

describe('terminal provider snapshot capabilities', () => {
  beforeEach(() => clearTerminalProviderSnapshotCapabilities())
  afterEach(() => vi.useRealTimers())

  // Superseded startup refreshes need a zero-delay retry; null would kill the only surviving timer chain.
  // Due retries must bypass same-array identity early-outs or the hook’s unchanged-ID chain dies.
  it('stops treating a session as gone once a pane respawns under its id', async () => {
    await synchronizeTerminalProviderSnapshotCapabilities(['dead-pty'], async (batch) =>
      batch.map((id) => ({ id, authoritative: false, gone: true }))
    )

    markTerminalProviderSessionAlive('dead-pty')

    expect(terminalProviderSessionIsGone('dead-pty')).toBe(false)
  })

  it('tracks sessions the provider reports gone and forgets them once the PTY is pruned', async () => {
    const resolve = vi.fn(async (batch: string[]) =>
      batch.map((id) => ({
        id,
        authoritative: false,
        ...(id === 'dead-pty' ? { gone: true } : {})
      }))
    )

    await synchronizeTerminalProviderSnapshotCapabilities(['dead-pty', 'live-pty'], resolve)

    expect(terminalProviderSessionIsGone('dead-pty')).toBe(true)
    expect(terminalProviderSessionIsGone('live-pty')).toBe(false)

    await synchronizeTerminalProviderSnapshotCapabilities(['live-pty'], resolve)
    expect(terminalProviderSessionIsGone('dead-pty')).toBe(false)
  })
})
