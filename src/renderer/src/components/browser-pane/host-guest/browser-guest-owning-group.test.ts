import { describe, expect, it, vi } from 'vitest'
import { focusOwningGroupForBrowserGuest } from './browser-guest-owning-group'

const browserTab = {
  contentType: 'browser' as const,
  entityId: 'workspace-1',
  groupId: 'group-2'
}

describe('focusOwningGroupForBrowserGuest', () => {
  it('focuses the split that owns the browser page', () => {
    const focusGroup = vi.fn()
    focusOwningGroupForBrowserGuest({
      worktreeId: 'wt-1',
      workspaceId: 'workspace-1',
      unifiedTabsByWorktree: { 'wt-1': [browserTab] },
      focusGroup
    })
    expect(focusGroup).toHaveBeenCalledTimes(1)
    expect(focusGroup).toHaveBeenCalledWith('wt-1', 'group-2')
  })

  it('does not match a page id against the workspace id stored on the tab', () => {
    const focusGroup = vi.fn()
    focusOwningGroupForBrowserGuest({
      worktreeId: 'wt-1',
      workspaceId: 'page-1',
      unifiedTabsByWorktree: {
        'wt-1': [{ contentType: 'browser', entityId: 'workspace-1', groupId: 'group-1' }]
      },
      focusGroup
    })
    expect(focusGroup).not.toHaveBeenCalled()
  })

  it('ignores the same page id on another worktree', () => {
    const focusGroup = vi.fn()
    focusOwningGroupForBrowserGuest({
      worktreeId: 'wt-1',
      workspaceId: 'workspace-1',
      unifiedTabsByWorktree: { 'wt-2': [browserTab] },
      focusGroup
    })
    expect(focusGroup).not.toHaveBeenCalled()
  })
})
