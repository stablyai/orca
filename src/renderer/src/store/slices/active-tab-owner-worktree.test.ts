import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'

const recordRendererCrashBreadcrumb = vi.fn()
vi.mock('../../lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (...args: unknown[]) => recordRendererCrashBreadcrumb(...args)
}))

const { resolveActiveTabOwnerWorktreeId, _resetDuplicateTabOwnerBreadcrumbsForTests } =
  await import('./active-tab-owner-worktree')

function tab(id: string, worktreeId: string): TerminalTab {
  return { id, worktreeId, title: id, createdAt: 0, sortOrder: 0 } as unknown as TerminalTab
}

beforeEach(() => {
  recordRendererCrashBreadcrumb.mockClear()
  _resetDuplicateTabOwnerBreadcrumbsForTests()
})

describe('resolveActiveTabOwnerWorktreeId', () => {
  it('returns the sole owner and stays quiet', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-a': [tab('t1', 'wt-a')], 'wt-b': [tab('t2', 'wt-b')] },
      'wt-a',
      't1'
    )
    expect(owner).toBe('wt-a')
    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('returns null when no worktree owns the tab', () => {
    expect(resolveActiveTabOwnerWorktreeId({ 'wt-a': [tab('t1', 'wt-a')] }, 'wt-a', 'gone')).toBe(
      null
    )
  })

  it('prefers the active worktree over an earlier-scanned duplicate', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-other': [tab('t1', 'wt-other')], 'wt-active': [tab('t1', 'wt-active')] },
      'wt-active',
      't1'
    )
    expect(owner).toBe('wt-active')
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_tab_id_owned_by_multiple_worktrees',
      { ownerCount: 2, resolvedToActiveWorktree: true }
    )
  })

  it('falls back to first match when the active worktree is not an owner', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-x': [tab('t1', 'wt-x')], 'wt-y': [tab('t1', 'wt-y')] },
      'wt-active',
      't1'
    )
    expect(owner).toBe('wt-x')
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_tab_id_owned_by_multiple_worktrees',
      { ownerCount: 2, resolvedToActiveWorktree: false }
    )
  })

  // Why: a truthiness guard on the active id would drop this back to first-match.
  it('prefers a falsy-but-valid active worktree id', () => {
    const owner = resolveActiveTabOwnerWorktreeId(
      { 'wt-other': [tab('t1', 'wt-other')], '': [tab('t1', '')] },
      '',
      't1'
    )
    expect(owner).toBe('')
  })

  it('breadcrumbs a given tab id once per verdict so it cannot flood the ring', () => {
    const maps = { 'wt-a': [tab('t1', 'wt-a')], 'wt-b': [tab('t1', 'wt-b')] }
    for (let i = 0; i < 5; i += 1) {
      resolveActiveTabOwnerWorktreeId(maps, 'wt-a', 't1')
    }
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(1)
  })

  // Why: the active worktree changes under a persisting duplicate, and coalescing
  // keeps only the newest payload — keyed on the tab id alone, whichever verdict
  // a tab reported first would suppress the other for the rest of the session.
  it('still reports a non-converging verdict after that tab id reported a converging one', () => {
    const maps = { 'wt-other': [tab('t1', 'wt-other')], 'wt-active': [tab('t1', 'wt-active')] }
    resolveActiveTabOwnerWorktreeId(maps, 'wt-active', 't1')
    resolveActiveTabOwnerWorktreeId(maps, 'wt-third', 't1')
    resolveActiveTabOwnerWorktreeId(maps, 'wt-third', 't1')

    expect(recordRendererCrashBreadcrumb.mock.calls).toEqual([
      [
        'terminal_tab_id_owned_by_multiple_worktrees',
        { ownerCount: 2, resolvedToActiveWorktree: true }
      ],
      [
        'terminal_tab_id_owned_by_multiple_worktrees',
        { ownerCount: 2, resolvedToActiveWorktree: false }
      ]
    ])
  })

  // Why the count and not just "reports twice": a guard keyed on the active
  // worktree id passes the two tests above yet emits once per worktree, which is
  // the flood this guard exists to prevent.
  it('never exceeds two crumbs for one tab id however the active worktree moves', () => {
    const maps = { 'wt-a': [tab('t1', 'wt-a')], 'wt-b': [tab('t1', 'wt-b')] }
    const activeWorktreeIds = ['wt-a', 'wt-b', 'wt-c', '', 'wt-d', 'wt-a']
    for (let i = 0; i < 600; i += 1) {
      resolveActiveTabOwnerWorktreeId(maps, activeWorktreeIds[i % activeWorktreeIds.length], 't1')
    }
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(2)
  })

  // Why: the guard set is never pruned and tab ids are minted per created tab.
  it('stops recording once the per-session sample cap is reached', () => {
    for (let i = 0; i < 400; i += 1) {
      const id = `t-${i}`
      const maps = { 'wt-a': [tab(id, 'wt-a')], 'wt-b': [tab(id, 'wt-b')] }
      resolveActiveTabOwnerWorktreeId(maps, 'wt-a', id)
      resolveActiveTabOwnerWorktreeId(maps, 'wt-c', id)
    }
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(256)
  })
})
