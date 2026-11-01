// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'

const getRuntimeGitHistoryMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitHistory: getRuntimeGitHistoryMock
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

import { useSourceControlGitHistory } from './use-git-history'

type Props = Parameters<typeof useSourceControlGitHistory>[0]

const props = (overrides: Partial<Props> = {}): Props => ({
  activeRepoTarget: { kind: 'local' },
  activeWorktreeId: 'wt-1',
  worktreePath: '\\\\wsl.localhost\\Ubuntu\\repo',
  compareBaseRef: 'main',
  isFolder: false,
  isBranchVisible: true,
  isGitHistoryExpanded: true,
  isGitHistoryVisible: true,
  worktreeMap: new Map([
    ['wt-1', {}],
    ['wt-2', {}]
  ]),
  ...overrides
})

const wakes = (): unknown[] =>
  getRuntimeGitHistoryMock.mock.calls.map((call) => call[1].wakeWslDistro)

beforeEach(() => {
  getRuntimeGitHistoryMock.mockReset().mockResolvedValue({ items: [] })
  resetWorkspaceSwitchUserActsForTests()
})
afterEach(cleanup)

// E9: only the user's own act may start a stopped WSL distro for a Commits read.
describe('Commits history and a stopped WSL distro', () => {
  it('stays background on a mount or remount with Commits already open', async () => {
    const first = renderHook(() => useSourceControlGitHistory(props()))
    await act(async () => {})
    first.unmount()
    renderHook(() => useSourceControlGitHistory(props()))
    await act(async () => {})
    expect(wakes()).toEqual([undefined, undefined])
  })

  it('wakes once for the user switching to the workspace, never again on a remount', async () => {
    noteUserWorkspaceSwitch('wt-1')
    const first = renderHook(() => useSourceControlGitHistory(props()))
    await act(async () => {})
    first.unmount()
    renderHook(() => useSourceControlGitHistory(props()))
    await act(async () => {})
    expect(wakes()).toEqual([true, undefined])
  })

  it('wakes when the user expands Commits, not when Orca re-shows it or a refresh follows', async () => {
    const { result, rerender } = renderHook((p: Props) => useSourceControlGitHistory(p), {
      initialProps: props({ isGitHistoryExpanded: false })
    })
    await act(async () => {})
    rerender(props())
    await act(async () => {})
    // Hidden and shown again by Orca (a sidebar re-show), with no switch.
    rerender(props({ isGitHistoryVisible: false }))
    rerender(props())
    await act(async () => {})
    await act(async () => result.current.refreshGitHistoryRef.current())
    expect(wakes()).toEqual([true, undefined, undefined])
  })

  it("does not take another worktree's restored expanded view as a click", async () => {
    const { rerender } = renderHook((p: Props) => useSourceControlGitHistory(p), {
      initialProps: props({ isGitHistoryExpanded: false })
    })
    await act(async () => {})
    rerender(props({ activeWorktreeId: 'wt-2' }))
    await act(async () => {})
    expect(wakes()).toEqual([undefined])
  })

  it("keeps the Refresh button's explicit wake", async () => {
    const { result } = renderHook(() => useSourceControlGitHistory(props()))
    await act(async () => {})
    await act(async () => result.current.refreshGitHistory({ wakeWslDistro: true }))
    expect(wakes()).toEqual([undefined, true])
  })
})
