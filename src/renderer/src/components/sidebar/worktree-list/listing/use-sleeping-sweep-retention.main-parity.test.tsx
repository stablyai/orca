// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { SLEEPING_SWEEP_SETTLE_MS } from '../../../../../../shared/sidebar-list/sleeping-sweep-retention'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { SidebarClock } from '../../../../../../main/runtime/sidebar-inputs/sidebar-clock'
import { SidebarRetentionOwner } from '../../../../../../main/runtime/sidebar-inputs/sidebar-retention-owner'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { makeTerminalTab } from '../../../../store/slices/worktrees-slice-test-fixtures'
import { useSleepingSweepRetention } from './use-sleeping-sweep-retention'

const initialState = useAppStore.getInitialState()
const repo = makeRepo()

/** Main's retention over the window's own store, so only the time rules can differ. */
function mainOwner(): SidebarRetentionOwner {
  return new SidebarRetentionOwner(new SidebarClock(), {
    showSleepingWorkspaces: () => useAppStore.getState().showSleepingWorkspaces,
    rowKeys: () =>
      (useAppStore.getState().worktreesByRepo[repo.id] ?? []).map(getWorktreeHostIdentity),
    watchRowKeys: () => () => {},
    retentionCandidates: () => {
      const state = useAppStore.getState()
      const live = (id: string): boolean =>
        (state.tabsByWorktree[id] ?? []).some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length)
      return {
        ids: (state.worktreesByRepo[repo.id] ?? []).map((w) => w.id),
        isActive: live,
        isUnverifiableGap: (id) => (state.tabsByWorktree[id]?.length ?? 0) > 0
      }
    }
  })
}

async function advance(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

describe('main sleeping retention against the window, on one fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000_000)
    useAppStore.setState(initialState, true)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('keeps and releases the same sleeping rows', async () => {
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [makeWorktree('a', 'A'), makeWorktree('b', 'B')] }
    })
    act(() =>
      useAppStore.setState({
        showSleepingWorkspaces: false,
        tabsByWorktree: { a: [makeTerminalTab({ id: 'tab-a', worktreeId: 'a' })] },
        ptyIdsByTabId: { 'tab-a': ['pty-a'] }
      })
    )
    const owner = mainOwner()
    owner.beginSession('s1')
    await advance(0)
    const window = renderHook(() =>
      useSleepingSweepRetention({
        enabled: !useAppStore((s) => s.showSleepingWorkspaces),
        worktreesByRepo: useAppStore((s) => s.worktreesByRepo),
        tabsByWorktree: useAppStore((s) => s.tabsByWorktree),
        ptyIdsByTabId: useAppStore((s) => s.ptyIdsByTabId),
        browserTabsByWorktree: {},
        worktreeIdsWithLiveAgent: new Set(),
        worktreeIdsWithStructuredChat: new Set()
      })
    )
    const mainRetained = (): string[] =>
      (owner.snapshot().retention?.retainedIds ?? []).map(getWorktreeIdFromHostIdentity)

    act(() => useAppStore.setState({ ptyIdsByTabId: {} }))
    owner.noteActivityChange()
    expect([...(window.result.current ?? [])]).toEqual(['a'])
    expect(mainRetained()).toEqual(['a'])

    await advance(SLEEPING_SWEEP_SETTLE_MS)
    expect([...(window.result.current ?? [])]).toEqual([])
    expect(mainRetained()).toEqual([])
  })
})
