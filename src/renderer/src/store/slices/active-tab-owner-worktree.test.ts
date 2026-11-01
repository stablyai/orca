import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

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
})
