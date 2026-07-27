import { describe, expect, it } from 'vitest'
import { getTabIdsAwaitingHostHydrationRemount } from './parked-terminal-host-hydration'

const baseState = {
  folderWorkspaces: [],
  projectGroups: [],
  repos: [{ id: 'repo1', connectionId: 'conn-1' }],
  worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1' }] },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
  ptyIdsByTabId: {}
}

describe('getTabIdsAwaitingHostHydrationRemount', () => {
  it('remounts a PTY-less tab once its owning host is known', () => {
    expect(getTabIdsAwaitingHostHydrationRemount(baseState as never)).toEqual(['tab-1'])
  })

  it('leaves tabs alone while the owner is still unresolved', () => {
    // repos: [] → getConnectionIdFromState returns undefined, the same state the
    // pane already parked on, so remounting would just re-park it in a loop.
    const state = { ...baseState, repos: [] }
    expect(getTabIdsAwaitingHostHydrationRemount(state as never)).toEqual([])
  })

  it('does not disturb a tab that already holds a PTY', () => {
    const state = {
      ...baseState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'ssh:conn-1@@pty-1' }] }
    }
    expect(getTabIdsAwaitingHostHydrationRemount(state as never)).toEqual([])
  })

  it('does not remount a tab whose PTY is tracked only by live id', () => {
    // A freshly spawned pane can publish into ptyIdsByTabId before the tab row
    // carries the id; remounting there would kill a healthy terminal.
    const state = { ...baseState, ptyIdsByTabId: { 'tab-1': ['pty-1'] } }
    expect(getTabIdsAwaitingHostHydrationRemount(state as never)).toEqual([])
  })

  it('remounts local worktrees too, not just SSH ones', () => {
    const state = { ...baseState, repos: [{ id: 'repo1', connectionId: null }] }
    expect(getTabIdsAwaitingHostHydrationRemount(state as never)).toEqual(['tab-1'])
  })
})
