import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshLocalStructuredSessionTabs } from './local-structured-session-tabs-sync'
import { callRuntimeRpc } from './runtime-rpc-client'
import { readStructuredSessionTabInventory } from './structured-session-tab-inventory'

vi.mock('./local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const SNAPSHOT = {
  worktree: 'wt-1',
  publicationEpoch: 'epoch-1',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: []
}

describe('readStructuredSessionTabInventory', () => {
  beforeEach(() => {
    vi.mocked(refreshLocalStructuredSessionTabs).mockReset()
    vi.mocked(callRuntimeRpc).mockReset()
  })

  it('refreshes this machine through its own sync, authoritatively', async () => {
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([SNAPSHOT])

    await expect(readStructuredSessionTabInventory({ kind: 'local' })).resolves.toEqual([SNAPSHOT])
    expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledWith(undefined, {
      authoritative: true
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('asks the paired server that owns the chat', async () => {
    const server = { kind: 'environment', environmentId: 'server-1' } as const
    vi.mocked(callRuntimeRpc).mockResolvedValue({ snapshots: [SNAPSHOT] })

    await expect(readStructuredSessionTabInventory(server)).resolves.toEqual([SNAPSHOT])
    expect(callRuntimeRpc).toHaveBeenCalledWith(server, 'session.tabs.listAll', {})
    expect(refreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
  })

  it('treats a malformed answer as no answer', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({})

    await expect(
      readStructuredSessionTabInventory({ kind: 'environment', environmentId: 'server-1' })
    ).rejects.toThrow('structured session inventory unavailable')
  })
})
