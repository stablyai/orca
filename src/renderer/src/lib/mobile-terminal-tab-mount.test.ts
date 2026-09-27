// Ownership itself is worktree-agnostic; this planner is where the worktree scope lives, because
// it mounts the tab under the requested worktree and a row filed elsewhere cannot be mounted there.
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { makeTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  planMobileTerminalTabMount,
  type MobileTerminalTabMountState
} from './mobile-terminal-tab-mount'

/** `tabCount` rows in `wt`, each with its own single-leaf layout bound to `wt@@<index>`. */
function state(tabCount = 1): MobileTerminalTabMountState {
  const tabs: TerminalTab[] = []
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  for (let index = 0; index < tabCount; index += 1) {
    const leafId = `leaf-${index}`
    tabs.push(makeTerminalTab({ id: `tab-${index}`, worktreeId: 'wt', sortOrder: index }))
    terminalLayoutsByTabId[`tab-${index}`] = {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: `wt@@${index}` }
    }
  }
  return { tabsByWorktree: { wt: tabs }, terminalLayoutsByTabId, ptyIdsByTabId: {} }
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

  it('mounts the tab whose pane is mounted when a stale layout row also claims the pty', () => {
    const s = state(200)
    s.ptyIdsByTabId['tab-173'] = ['wt@@173']
    s.terminalLayoutsByTabId['tab-199'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { leaf: 'wt@@173' }
    }

    expect(planMobileTerminalTabMount(s, { worktreeId: 'wt', ptyId: 'wt@@173' })).toEqual({
      worktreeId: 'wt',
      tabIds: ['tab-173']
    })
  })

  it('refuses a pty whose owning row is filed under another worktree key', () => {
    // Absorbed from the deleted terminal-tab-for-pty-id suite: the lookup no longer scopes by
    // worktree, so the planner must, or a stale handle mounts a hidden workspace (#8597).
    expect(planMobileTerminalTabMount(state(), { worktreeId: 'other', ptyId: 'wt@@0' })).toBeNull()
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
    expect(isTabMounted).toHaveBeenCalledWith('tab-173', 'wt')
  })

  it('passes the requested worktree to the mounted-tab predicate', () => {
    const isTabMounted = vi.fn(() => false)

    expect(
      planMobileTerminalTabMount(state(), { worktreeId: 'wt', tabId: 'tab-0' }, { isTabMounted })
    ).toEqual({ worktreeId: 'wt', tabIds: ['tab-0'] })
    expect(isTabMounted).toHaveBeenCalledWith('tab-0', 'wt')
  })
})
