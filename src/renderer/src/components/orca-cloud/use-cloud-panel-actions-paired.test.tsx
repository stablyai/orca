// @vitest-environment happy-dom
// PAIRED-CHROME: a paired row's hovercard offers only what main can do for it today (Sleep, Delete);
// Wake, Restart, Archive, Unarchive and Move here wait for PAIRED-WAKE / PAIRED-ARCHIVE.
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ paired: false }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({})
}))
vi.mock('@/store/github/refresh/worktree-refresh', () => ({ findWorktreeById: () => null }))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))
vi.mock('@/lib/orca-cloud/orca-cloud-move-store', () => ({ openMoveToThisComputer: vi.fn() }))
vi.mock('@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow', () => ({
  runSleepWorktree: vi.fn()
}))
vi.mock('@/components/sidebar/workspace-actions/deletion/delete-worktree-flow', () => ({
  runWorktreeDelete: vi.fn()
}))
vi.mock('./cloud-workspace-actions', () => ({
  runArchiveCloudWorkspace: vi.fn(),
  runRestartCloudWorkspace: vi.fn(),
  runUnarchiveCloudWorkspace: vi.fn(),
  wakeCloudWorkspace: vi.fn()
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  useCloudWorkspace: (select: (state: unknown) => unknown) => select({})
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-rows', () => ({
  isPairedCloudStatusRow: () => mocks.paired
}))

const { useCloudPanelActions } = await import('./use-cloud-panel-actions')

const offered = (): string[] =>
  Object.keys(renderHook(() => useCloudPanelActions('wt', () => undefined)).result.current).sort()

describe('the hovercard actions on a paired row', () => {
  it('an owned row keeps every action', () => {
    mocks.paired = false
    expect(offered()).toEqual([
      'onArchive',
      'onDelete',
      'onMoveToComputer',
      'onRestart',
      'onSleep',
      'onUnarchive',
      'onWake'
    ])
  })

  it('a paired row offers Wake, Restart, Sleep and Delete (PAIRED-WAKE); not Archive or Move yet', () => {
    mocks.paired = true
    expect(offered()).toEqual(['onDelete', 'onRestart', 'onSleep', 'onWake'])
  })
})
