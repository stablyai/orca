// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Worktree } from '../../../../shared/worktree/types'
import { useBotWorkspaceOrder } from './use-bot-workspace-order'

const initialState = useAppStore.getInitialState()

// Saved order says older first; recent activity says newer first.
const older = makeWorktree({
  id: 'repo-1::/older',
  repoId: 'repo-1',
  displayName: 'older',
  sortOrder: 2,
  lastActivityAt: 100
})
const newer = makeWorktree({
  id: 'repo-1::/newer',
  repoId: 'repo-1',
  displayName: 'newer',
  sortOrder: 1,
  lastActivityAt: 900
})
const worktrees: readonly Worktree[] = [older, newer]

function liveTerminal(live: boolean): void {
  const ptyIdsByTabId: Record<string, string[]> = live ? { 'tab-1': ['pty-1'] } : {}
  useAppStore.setState((state) => ({
    tabsByWorktree: {
      [newer.id]: [
        {
          id: 'tab-1',
          ptyId: 'pty-1',
          worktreeId: newer.id,
          title: 'zsh',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId,
    settledSortEpoch: state.settledSortEpoch + 1
  }))
}

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('useBotWorkspaceOrder', () => {
  it('keeps Smart live once a live signal has shown, as the project list does', () => {
    const { result } = renderHook(() => useBotWorkspaceOrder(worktrees))
    // Before any live signal, Smart follows the saved order.
    expect(result.current.map((w) => w.displayName)).toEqual(['older', 'newer'])

    act(() => liveTerminal(true))
    expect(result.current.map((w) => w.displayName)).toEqual(['newer', 'older'])

    // The terminal ends; the latched list keeps ranking by activity, not the saved order.
    act(() => liveTerminal(false))
    expect(result.current.map((w) => w.displayName)).toEqual(['newer', 'older'])
  })
})
