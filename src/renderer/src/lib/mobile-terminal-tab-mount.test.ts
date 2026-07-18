import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { planMobileTerminalTabMount } from './mobile-terminal-tab-mount'

type PlannerState = Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>

function state(tabCount = 1): PlannerState {
  return {
    tabsByWorktree: {
      wt: Array.from({ length: tabCount }, (_, index) => ({
        id: `tab-${index}`,
        ptyId: `wt@@${index}`
      }))
    } as unknown as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: {}
  }
}

describe('planMobileTerminalTabMount', () => {
  it('keeps real-tab requests targeted to exactly one tab', () => {
    expect(planMobileTerminalTabMount(state(), { worktreeId: 'wt', tabId: 'tab-0' })).toEqual({
      worktreeId: 'wt',
      tabIds: ['tab-0']
    })
  })

  it('resolves synthetic handles to exactly one owning tab at workspace scale', () => {
    expect(planMobileTerminalTabMount(state(200), { worktreeId: 'wt', ptyId: 'wt@@173' })).toEqual({
      worktreeId: 'wt',
      tabIds: ['tab-173']
    })
  })

  it('does not mount the whole worktree when a stale pty id has no owner', () => {
    expect(
      planMobileTerminalTabMount(state(200), { worktreeId: 'wt', ptyId: 'wt@@missing' })
    ).toBeNull()
  })

  it('does not mount either tab when stale persistence has duplicate pty ownership', () => {
    const s = state(200)
    s.terminalLayoutsByTabId['tab-199'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { leaf: 'wt@@173' }
    }

    expect(planMobileTerminalTabMount(s, { worktreeId: 'wt', ptyId: 'wt@@173' })).toBeNull()
  })

  it('does not mount a hidden worktree for a stale direct tab id', () => {
    const isTabMounted = vi.fn()

    expect(
      planMobileTerminalTabMount(
        state(200),
        { worktreeId: 'wt', tabId: 'tab-missing' },
        { isTabMounted }
      )
    ).toBeNull()
    expect(isTabMounted).not.toHaveBeenCalled()
  })

  it('does not schedule hidden layout work for an already-mounted tab', () => {
    const isTabMounted = vi.fn().mockReturnValue(true)

    expect(
      planMobileTerminalTabMount(
        state(200),
        { worktreeId: 'wt', ptyId: 'wt@@173' },
        { isTabMounted }
      )
    ).toBeNull()
    expect(isTabMounted).toHaveBeenCalledTimes(1)
    expect(isTabMounted).toHaveBeenCalledWith('tab-173')
  })
})
