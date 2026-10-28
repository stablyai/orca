import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTerminalTabsParkedOnUnresolvedHost,
  getTabIdsAwaitingHostHydrationRemount,
  recordTerminalTabParkedOnUnresolvedHost
} from './parked-terminal-host-hydration'

const baseState = {
  folderWorkspaces: [],
  projectGroups: [],
  repos: [{ id: 'repo1', connectionId: 'conn-1' }],
  worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1' }] },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
  ptyIdsByTabId: {}
}

beforeEach(() => {
  clearTerminalTabsParkedOnUnresolvedHost()
})

describe('getTabIdsAwaitingHostHydrationRemount', () => {
  it('remounts a parked tab only once per park', () => {
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    expect(getTabIdsAwaitingHostHydrationRemount(baseState as never)).toEqual(['tab-1'])
    expect(getTabIdsAwaitingHostHydrationRemount(baseState as never)).toEqual([])
  })

  it('keeps a parked tab pending while the owner is still unresolved', () => {
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    const unresolved = { ...baseState, repos: [] }
    expect(getTabIdsAwaitingHostHydrationRemount(unresolved as never)).toEqual([])
    expect(getTabIdsAwaitingHostHydrationRemount(baseState as never)).toEqual(['tab-1'])
  })

  it('drops a parked tab that acquired a PTY by other means', () => {
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    const withPty = {
      ...baseState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'ssh:conn-1@@pty-1' }] }
    }
    expect(getTabIdsAwaitingHostHydrationRemount(withPty as never)).toEqual([])
  })

  it('does not remount a parked tab whose PTY is tracked only by live id', () => {
    recordTerminalTabParkedOnUnresolvedHost('wt-1', 'tab-1')
    const state = { ...baseState, ptyIdsByTabId: { 'tab-1': ['pty-1'] } }
    expect(getTabIdsAwaitingHostHydrationRemount(state as never)).toEqual([])
  })
})
