import { describe, expect, it } from 'vitest'
import { resolveAgentDashboardInitialView } from './agent-dashboard-default-view'

describe('resolveAgentDashboardInitialView', () => {
  it('keeps the status board when the worktree-view setting is off or unset', () => {
    expect(resolveAgentDashboardInitialView({})).toBe('board')
    expect(resolveAgentDashboardInitialView({ defaultWorktreeView: false })).toBe('board')
    expect(resolveAgentDashboardInitialView({ defaultWorktreeView: null })).toBe('board')
    expect(resolveAgentDashboardInitialView({ requestedView: null })).toBe('board')
    expect(resolveAgentDashboardInitialView({ requestedView: '' })).toBe('board')
    expect(resolveAgentDashboardInitialView({ requestedView: 'unknown' })).toBe('board')
  })

  it('opens the worktree map when the setting is on and no override is set', () => {
    expect(resolveAgentDashboardInitialView({ defaultWorktreeView: true })).toBe('map')
  })

  it('lets an explicit per-session view override the persisted default', () => {
    expect(
      resolveAgentDashboardInitialView({
        defaultWorktreeView: true,
        requestedView: 'board'
      })
    ).toBe('board')
    expect(
      resolveAgentDashboardInitialView({
        defaultWorktreeView: true,
        requestedView: 'kanban'
      })
    ).toBe('board')
    expect(
      resolveAgentDashboardInitialView({
        defaultWorktreeView: false,
        requestedView: 'map'
      })
    ).toBe('map')
    expect(
      resolveAgentDashboardInitialView({
        defaultWorktreeView: false,
        requestedView: 'rings'
      })
    ).toBe('map')
  })
})
