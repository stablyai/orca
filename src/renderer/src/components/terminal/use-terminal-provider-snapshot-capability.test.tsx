// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  clearTerminalProviderSnapshotCapabilities,
  collectTerminalProviderSnapshotPtyIds,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

type HookStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  pendingReconnectPtyIdByTabId?: Record<string, string>
  terminalLayoutsByTabId?: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
}

const storeState: HookStoreState = {
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
    storeState.tabsByWorktree = {
      'repo::worktree': [{ id: 'tab-1', ptyId: 'ssh:target@@pty-1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-1': ['ssh:target@@pty-1'] }
    ;(window as unknown as { api: unknown }).api = {
      pty: { getAuthoritativeBufferSnapshotCapabilities: resolveCapabilities }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
    delete storeState.pendingReconnectPtyIdByTabId
    delete storeState.terminalLayoutsByTabId
  })

  // Why: synchronization PRUNES cached verdicts outside its collected set, so
  // the ongoing collector must gather the same fields startup does
  // (pending-reconnect and split-leaf layout ptys) or their startup answers
  // decay back into exempt-by-default unknown.
  it('keeps startup verdicts for split-leaf and pending-reconnect ptys alive', async () => {
    storeState.pendingReconnectPtyIdByTabId = { 'tab-2': 'ssh:target@@restored' }
    storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { leaf: 'ssh:target@@split' } }
    }
    const startupResolver = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    await synchronizeTerminalProviderSnapshotCapabilities(
      collectTerminalProviderSnapshotPtyIds(storeState),
      startupResolver
    )
    expect(terminalProviderHasAuthoritativeSnapshot('ssh:target@@split')).toBe(true)
    resolveCapabilities.mockResolvedValue([])

    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await Promise.resolve()

    for (const ptyId of ['ssh:target@@pty-1', 'ssh:target@@split', 'ssh:target@@restored']) {
      expect(terminalProviderHasAuthoritativeSnapshot(ptyId)).toBe(true)
    }
    hook.unmount()
  })

  // Why: the collect key is memoized on the four store maps; a missing memo
  // dep would freeze the key and silently drop new split-leaf ptys from the
  // sync — a stale-collector correctness bug, not a perf one.
  it('re-collects when a split leaf pty appears in the layouts map', async () => {
    resolveCapabilities.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())

    storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { leaf: 'ssh:target@@new-split' } }
    }
    hook.rerender()

    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['ssh:target@@new-split'])
    )
    hook.unmount()
  })

  it('preserves newline-bearing folder-workspace pty ids in the memo key', async () => {
    const newlinePtyId = 'repo::folder\nname@@pty-1'
    storeState.tabsByWorktree = {
      'repo::folder\nname': [{ id: 'tab-1', ptyId: newlinePtyId }]
    }
    storeState.ptyIdsByTabId = { 'tab-1': [newlinePtyId] }
    resolveCapabilities.mockResolvedValue([{ id: newlinePtyId, authoritative: true }])

    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))

    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledWith([newlinePtyId]))
    hook.unmount()
  })

  // Why per-map: every dep of the collect-key memo is individually
  // load-bearing, and exhaustive-deps is only a warn in this repo — a dropped
  // dep silently freezes the key for exactly that map's changes.
  it('re-collects when each remaining collected store map changes', async () => {
    resolveCapabilities.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())

    storeState.pendingReconnectPtyIdByTabId = { 'tab-9': 'ssh:target@@reconnect' }
    hook.rerender()
    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['ssh:target@@reconnect'])
    )

    storeState.tabsByWorktree = {
      'repo::worktree': [
        ...storeState.tabsByWorktree['repo::worktree'],
        { id: 'tab-2', ptyId: 'ssh:target@@tab-2' }
      ]
    }
    hook.rerender()
    await waitFor(() => expect(resolveCapabilities).toHaveBeenLastCalledWith(['ssh:target@@tab-2']))

    storeState.ptyIdsByTabId = {
      ...storeState.ptyIdsByTabId,
      'tab-2': ['ssh:target@@tab-2-split']
    }
    hook.rerender()
    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['ssh:target@@tab-2-split'])
    )
    hook.unmount()
  })

  it('prefetches restored PTYs after render before activation is enabled', async () => {
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: false }])

    const hook = renderHook(() => {
      useTerminalProviderSnapshotCapability(false)
      expect(resolveCapabilities).not.toHaveBeenCalled()
    })

    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())
    expect(resolveCapabilities).toHaveBeenCalledWith(['ssh:target@@pty-1'])
    hook.unmount()
  })

  it('does not poll again after a provider returns a definitive result', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'ssh:target@@pty-1', authoritative: false }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.runAllTimersAsync()

    expect(resolveCapabilities).toHaveBeenCalledOnce()
    hook.unmount()
  })

  // Why: the timer chain is the sole recovery vehicle for unknown verdicts,
  // and its refire reuses the same memoized id array — this pins the backoff
  // return, the rescheduled timer, and the same-identity re-ask end to end.
  it('polls an unknown pty again on the retry timer without any id churn', async () => {
    vi.useFakeTimers()
    resolveCapabilities
      .mockResolvedValueOnce([{ id: 'ssh:target@@pty-1', authoritative: null }])
      .mockResolvedValueOnce([{ id: 'ssh:target@@pty-1', authoritative: true }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    const initialRevision = hook.result.current
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapabilities).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(resolveCapabilities).toHaveBeenCalledTimes(2)
    expect(terminalProviderHasAuthoritativeSnapshot('ssh:target@@pty-1')).toBe(true)
    expect(hook.result.current).toBeGreaterThan(initialRevision)
    hook.unmount()
  })

  // Why source-pinned: the hook test cannot prove the quiet parking effect consumes the external revision.
  it('invalidates the Terminal parking pass when a capability verdict changes', () => {
    const projectionSource = readFileSync(
      join(__dirname, '../use-terminal-workspace-projection.ts'),
      'utf8'
    )
    const parkingSource = readFileSync(join(__dirname, '../use-terminal-parking-pass.ts'), 'utf8')

    expect(projectionSource).toContain(
      'const terminalProviderSnapshotCapabilityRevision = useTerminalProviderSnapshotCapability('
    )
    expect(projectionSource).toContain('terminalProviderSnapshotCapabilityRevision')
    expect(parkingSource.match(/terminalProviderSnapshotCapabilityRevision/g)).toHaveLength(2)
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
