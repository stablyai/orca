import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markVisited } from './worktree-activation-visit'
import {
  lastUserWorkspaceSwitchAt,
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests,
  takeWorkspaceSwitchWake
} from './workspace-switch-user-act'

describe("the user's switch to a workspace (E9)", () => {
  beforeEach(() => resetWorkspaceSwitchUserActsForTests())

  it("is recorded only for an open its caller marked as the user's", () => {
    const state = {
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      markWorktreeVisited: vi.fn()
    }
    const previous = { worktreeId: null, hostId: null }
    markVisited(state, 'wt-1', previous)
    expect(lastUserWorkspaceSwitchAt('wt-1')).toBeUndefined()
    markVisited(state, 'wt-1', previous, undefined, 'user-open')
    expect(lastUserWorkspaceSwitchAt('wt-1')).toEqual(expect.any(Number))
    expect(lastUserWorkspaceSwitchAt('wt-2')).toBeUndefined()
  })

  it('counts a switch for a consumer only while it is recent, when asked', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    noteUserWorkspaceSwitch('wt-1')
    now.mockReturnValue(20_000)
    expect(takeWorkspaceSwitchWake('wt-1', 'pane-restore:a', { withinMs: 10_000 })).toBe(false)
    now.mockReturnValue(5_000)
    expect(takeWorkspaceSwitchWake('wt-1', 'pane-restore:b', { withinMs: 10_000 })).toBe(true)
    now.mockRestore()
  })

  it('wakes each consumer once per switch; a remount with no new switch does not', () => {
    noteUserWorkspaceSwitch('wt-1')
    expect(takeWorkspaceSwitchWake('wt-1', 'explorer')).toBe(true)
    expect(takeWorkspaceSwitchWake('wt-1', 'explorer')).toBe(false)
    expect(takeWorkspaceSwitchWake('wt-1', 'git-status')).toBe(true)
    noteUserWorkspaceSwitch('wt-1')
    expect(takeWorkspaceSwitchWake('wt-1', 'explorer')).toBe(true)
    expect(takeWorkspaceSwitchWake('wt-2', 'explorer')).toBe(false)
  })
})
