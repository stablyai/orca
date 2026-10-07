// why: the hook renders through React DOM, so @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { SourceControlTargetProvider } from '../panel/source-control-target-worktree'
import { useSourceControlTargetStatusPoll } from './use-target-status-poll'

type RefreshCall = { signal?: AbortSignal; tier?: string; settle: () => void }

const initialAppState = useAppStore.getInitialState()
const worktreeA = makeWorktree({ id: 'repo1::/repo1', repoId: 'repo1', path: '/repo1' })
const worktreeB = makeWorktree({ id: 'repo1::/repo1-b', repoId: 'repo1', path: '/repo1-b' })

let calls: RefreshCall[] = []
function refresh(signal?: AbortSignal, tier?: 'interactive' | 'status'): Promise<void> {
  return new Promise((resolve) => {
    calls.push({ signal, tier, settle: resolve })
  })
}

function wrapper(worktree: Worktree, isActive: boolean) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
      <SourceControlTargetProvider worktree={worktree} isActive={isActive}>
        {children}
      </SourceControlTargetProvider>
    )
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({ activeWorktreeId: worktreeA.id })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useSourceControlTargetStatusPoll', () => {
  it('polls a pinned sibling on the status tier and skips ticks while one is in flight', async () => {
    renderHook(
      () =>
        useSourceControlTargetStatusPoll({
          activeConnectionId: null,
          isBranchVisible: true,
          refreshActiveGitStatus: refresh
        }),
      { wrapper: wrapper(worktreeB, true) }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].tier).toBe('status')

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(calls).toHaveLength(1)

    await act(async () => {
      calls[0].settle()
    })
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(calls).toHaveLength(2)
  })

  it('aborts the in-flight refresh and stops ticking once the section collapses', async () => {
    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) =>
        useSourceControlTargetStatusPoll({
          activeConnectionId: null,
          isBranchVisible: visible,
          refreshActiveGitStatus: refresh
        }),
      { wrapper: wrapper(worktreeB, true), initialProps: { visible: true } }
    )
    expect(calls).toHaveLength(1)

    rerender({ visible: false })
    expect(calls[0].signal?.aborted).toBe(true)
    await act(async () => {
      calls[0].settle()
      vi.advanceTimersByTime(60_000)
    })
    expect(calls).toHaveLength(1)
  })

  it('leaves the active worktree to the app-wide poller', () => {
    renderHook(
      () =>
        useSourceControlTargetStatusPoll({
          activeConnectionId: null,
          isBranchVisible: true,
          refreshActiveGitStatus: refresh
        }),
      { wrapper: wrapper(worktreeA, true) }
    )
    expect(calls).toEqual([])
  })
})
