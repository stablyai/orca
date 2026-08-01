// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { clearTerminalProviderSnapshotCapabilities } from './terminal-provider-snapshot-capability'

const storeState = {
  tabsByWorktree: {
    'repo::worktree': [{ id: 'tab-1', ptyId: 'ssh:target@@pty-1' }]
  },
  ptyIdsByTabId: { 'tab-1': ['ssh:target@@pty-1'] }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { useTerminalProviderSnapshotCapability } from './use-terminal-provider-snapshot-capability'

describe('useTerminalProviderSnapshotCapability', () => {
  const resolveCapabilities = vi.fn()

  beforeEach(() => {
    clearTerminalProviderSnapshotCapabilities()
    resolveCapabilities.mockReset()
    ;(window as unknown as { api: unknown }).api = {
      pty: { getAuthoritativeBufferSnapshotCapabilities: resolveCapabilities }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('prefetches restored PTYs after render before activation is enabled', async () => {
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: false }])

    renderHook(() => {
      useTerminalProviderSnapshotCapability(false)
      expect(resolveCapabilities).not.toHaveBeenCalled()
    })

    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())
    expect(resolveCapabilities).toHaveBeenCalledWith(['ssh:target@@pty-1'])
  })

  it('does not poll again after a provider returns a definitive result', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: false }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.runAllTimersAsync()

    expect(resolveCapabilities).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('cancels an unknown-capability retry when the hook unmounts', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: null }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapabilities).toHaveBeenCalledOnce()

    hook.unmount()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(resolveCapabilities).toHaveBeenCalledOnce()
  })
})
