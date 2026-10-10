// @vitest-environment happy-dom

import { StrictMode, Suspense, startTransition, useEffect } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import {
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../../../worktree-jump-palette-test-fixtures'
import { SLEEPING_SWEEP_SETTLE_MS } from '../../sleeping-sweep-retention'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const worktree = makeWorktree('remote', 'Remote workspace', { hostId: 'ssh:box' })
const tab = makeTerminalTab('terminal', worktree.id, 'Remote session')
const ptyId = 'remote:pty-1'
const args: Parameters<typeof useVisibleSidebarWorktrees>[0] = {
  filterState: {
    showSleepingWorkspaces: false,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: false,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all'
  },
  sortBy: 'recent',
  sortedIds: [worktree.id],
  repoMap: new Map([[repo.id, repo]]),
  worktreeLineageById: {},
  defaultHostId: LOCAL_EXECUTION_HOST_ID,
  agentSendTargetWorktreeId: null
}

function setPtyBound(bound: boolean): void {
  act(() => useAppStore.setState({ ptyIdsByTabId: { [tab.id]: bound ? [ptyId] : [] } }))
}

function visibleIds(result: ReturnType<typeof useVisibleSidebarWorktrees>): string[] {
  return result.visibleWorktrees.map((row) => row.id)
}

describe('useVisibleSidebarWorktrees sleeping retention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ptyId] }
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  it('retains a newly added active row missing from the cached sort order', () => {
    useAppStore.setState({ worktreesByRepo: {} })
    const { result } = renderHook(() => useVisibleSidebarWorktrees({ ...args, sortedIds: [] }))
    expect(visibleIds(result.current)).toEqual([])

    act(() => useAppStore.setState({ worktreesByRepo: { [repo.id]: [worktree] } }))
    expect(visibleIds(result.current)).toEqual([worktree.id])
    setPtyBound(false)
    expect(visibleIds(result.current)).toEqual([worktree.id])
    act(() => vi.advanceTimersByTime(SLEEPING_SWEEP_SETTLE_MS))
    expect(visibleIds(result.current)).toEqual([])
  })

  it('starts and expires a full grace window for committed StrictMode renders', () => {
    const { result } = renderHook(() => useVisibleSidebarWorktrees(args), { wrapper: StrictMode })
    setPtyBound(false)
    expect(visibleIds(result.current)).toEqual([worktree.id])
    act(() => vi.advanceTimersByTime(SLEEPING_SWEEP_SETTLE_MS - 1))
    expect(visibleIds(result.current)).toEqual([worktree.id])
    act(() => vi.advanceTimersByTime(1))
    expect(visibleIds(result.current)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start a grace deadline in a suspended uncommitted render', () => {
    let suspend = false
    let commits = 0
    let suspendedRenders = 0
    const pending = new Promise<void>(() => {})
    function Probe() {
      const result = useVisibleSidebarWorktrees(args)
      useEffect(() => {
        commits += 1
      })
      if (suspend) {
        suspendedRenders += 1
        throw pending
      }
      return <span>{visibleIds(result).join(',')}</span>
    }
    const view = () => (
      <Suspense fallback={<span>Pending</span>}>
        <Probe />
      </Suspense>
    )
    const rendered = render(view())
    const initialCommits = commits
    suspend = true
    setPtyBound(false)
    expect(suspendedRenders).toBeGreaterThan(0)
    expect(commits).toBe(initialCommits)

    vi.setSystemTime(1_000 + SLEEPING_SWEEP_SETTLE_MS)
    suspend = false
    rendered.rerender(view())
    expect(rendered.getByText(worktree.id)).toBeDefined()
    act(() => vi.advanceTimersByTime(SLEEPING_SWEEP_SETTLE_MS - 1))
    expect(rendered.getByText(worktree.id)).toBeDefined()
    act(() => vi.advanceTimersByTime(1))
    expect(rendered.queryByText(worktree.id)).toBeNull()
  })

  it('does not reset committed retention when a show-sleeping transition is abandoned', async () => {
    let suspendedRenders = 0
    let sleepingCommits = 0
    const pending = new Promise<void>(() => {})
    function Probe({ showSleeping }: { showSleeping: boolean }) {
      const result = useVisibleSidebarWorktrees({
        ...args,
        filterState: { ...args.filterState, showSleepingWorkspaces: showSleeping }
      })
      useEffect(() => {
        if (showSleeping) {
          sleepingCommits += 1
        }
      }, [showSleeping])
      if (showSleeping) {
        suspendedRenders += 1
        throw pending
      }
      return <span>{visibleIds(result).join(',')}</span>
    }
    const view = (showSleeping: boolean) => (
      <Suspense fallback={<span>Pending</span>}>
        <Probe showSleeping={showSleeping} />
      </Suspense>
    )
    const rendered = render(view(false))
    await act(async () => {
      startTransition(() => rendered.rerender(view(true)))
    })
    expect(suspendedRenders).toBeGreaterThan(0)
    expect(sleepingCommits).toBe(0)
    expect(rendered.queryByText('Pending')).toBeNull()

    rendered.rerender(view(false))
    setPtyBound(false)
    expect(rendered.getByText(worktree.id)).toBeDefined()
    act(() => vi.advanceTimersByTime(SLEEPING_SWEEP_SETTLE_MS))
    expect(rendered.queryByText(worktree.id)).toBeNull()
  })

  it('forgets removed current worktrees even when their cached sort ID remains', () => {
    const { result } = renderHook(() => useVisibleSidebarWorktrees(args))
    act(() => useAppStore.setState({ worktreesByRepo: {} }))
    setPtyBound(false)
    act(() => useAppStore.setState({ worktreesByRepo: { [repo.id]: [worktree] } }))
    expect(visibleIds(result.current)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears retention when showing sleeping workspaces actually commits', () => {
    const { result, rerender } = renderHook(
      (showSleeping: boolean) =>
        useVisibleSidebarWorktrees({
          ...args,
          filterState: { ...args.filterState, showSleepingWorkspaces: showSleeping }
        }),
      { initialProps: false }
    )
    rerender(true)
    setPtyBound(false)
    rerender(false)
    expect(visibleIds(result.current)).toEqual([])
  })
})
