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
})
