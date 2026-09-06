// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_TERMINAL_COMMAND_FINISHED_EVENT,
  type TerminalCommandFinishedEventDetail
} from '@/hooks/terminal-command-finished-event'
import {
  ORCA_WORKTREE_FILE_CHANGE_EVENT,
  type WorktreeFileChangeEventDetail
} from '@/hooks/worktree-file-change-event'
import { useSourceControlStatusRefresh } from './use-status-refresh'

// Why: the module under test shells out to the real git status refresher; a spy lets the test
// assert which signals actually prod a refresh without touching the filesystem.
const refreshGitStatusForWorktree = vi.fn()

vi.mock('../../git-status-refresh', () => ({
  refreshGitStatusForWorktree: (...args: unknown[]) => refreshGitStatusForWorktree(...args)
}))

vi.mock('../../git-status-file-watch-refresh', () => ({
  shouldRefreshGitStatusForFileChange: () => true
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

vi.mock('@/lib/window-visibility-interval', () => ({
  isWindowVisible: () => true
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-viewed'
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string) => key
}))

vi.mock('sonner', () => ({
  toast: { warning: vi.fn() }
}))

const state = vi.hoisted(() => ({
  setGitStatus: vi.fn(),
  updateWorktreeGitIdentity: vi.fn(),
  setUpstreamStatus: vi.fn(),
  fetchUpstreamStatus: vi.fn(),
  activeWorktreeId: 'wt-active'
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
}))

function Harness(): React.JSX.Element {
  useSourceControlStatusRefresh({
    activeRepoSettings: null,
    activeWorktreeId: 'wt-viewed',
    worktreePath: '/repo/viewed',
    isFolder: false,
    repositoryHuge: null,
    activeConnectionId: null,
    worktreeMap: new Map()
  })
  return <div />
}

describe('useSourceControlStatusRefresh viewed-worktree lane', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    refreshGitStatusForWorktree.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('refreshes once immediately when the picker lands on a non-active worktree', () => {
    render(<Harness />)
    // Why: the gate requires the subject to differ from the app-active id; with a 60s interval
    // and no signal yet, exactly one refresh (the selection seed) must have fired.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
  })

  it('recurringly polls the viewed non-active worktree while visible', () => {
    render(<Harness />)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
  })

  it('debounces a terminal-command-finished signal for the viewed worktree', () => {
    render(<Harness />)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    const detail: TerminalCommandFinishedEventDetail = {
      worktreeId: 'wt-viewed',
      exitCode: 0
    }
    window.dispatchEvent(
      new CustomEvent(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, { detail })
    )
    // Why: only a debounce timer is pending; it must not fire before the floor.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(125)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
  })

  it('ignores terminal-command-finished signals for other worktrees', () => {
    render(<Harness />)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new CustomEvent(ORCA_TERMINAL_COMMAND_FINISHED_EVENT, {
        detail: { worktreeId: 'wt-other', exitCode: null } satisfies TerminalCommandFinishedEventDetail
      })
    )
    vi.advanceTimersByTime(125)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
  })

  it('debounces a matching worktree file-change signal', () => {
    render(<Harness />)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: {
          runtimeEnvironmentId: 'env-viewed',
          payload: { worktreePath: '/repo/viewed', events: [] }
        } satisfies WorktreeFileChangeEventDetail
      })
    )
    vi.advanceTimersByTime(125)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
  })

  it('ignores file-change signals from another runtime environment', () => {
    render(<Harness />)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: {
          runtimeEnvironmentId: 'env-other',
          payload: { worktreePath: '/repo/viewed', events: [] }
        } satisfies WorktreeFileChangeEventDetail
      })
    )
    vi.advanceTimersByTime(125)
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
  })
})
