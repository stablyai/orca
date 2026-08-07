import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  graftLocalTabsIntoRemoteSession,
  staleDirectSshSnapshotTabIds
} from './remote-workspace-snapshot-apply'

const WT = 'repo-1::/home/user/worktree-a'
const OTHER_WT = 'repo-1::/home/user/worktree-b'

function tab(id: string, worktreeId: string): TerminalTab {
  return { id, worktreeId, title: id, ptyId: `pty-${id}` } as TerminalTab
}

function tabsByWorktree(
  entries: Record<string, TerminalTab[]>
): WorkspaceSessionState['tabsByWorktree'] {
  return entries
}

describe('staleDirectSshSnapshotTabIds', () => {
  it('returns nothing when no local tabs are live', () => {
    expect(staleDirectSshSnapshotTabIds(tabsByWorktree({}), new Set([WT]), new Set())).toEqual([])
  })

  it('returns nothing when every live tab is listed in the snapshot', () => {
    const stale = staleDirectSshSnapshotTabIds(
      tabsByWorktree({ [WT]: [tab('tab-1', WT), tab('tab-2', WT)] }),
      new Set([WT]),
      new Set(['tab-1'])
    )
    expect(stale).toEqual([])
  })

  it('reports a live tab the snapshot omits from its worktree list', () => {
    const stale = staleDirectSshSnapshotTabIds(
      tabsByWorktree({ [WT]: [tab('tab-old', WT)] }),
      new Set([WT]),
      new Set(['tab-fresh'])
    )
    expect(stale).toEqual(['tab-fresh'])
  })

  it('reports a live tab when the snapshot has no entry for its worktree at all', () => {
    const stale = staleDirectSshSnapshotTabIds(
      tabsByWorktree({}),
      new Set([WT]),
      new Set(['tab-fresh'])
    )
    expect(stale).toEqual(['tab-fresh'])
  })

  it('reports a live tab as stale even when a same-id tab sits under an out-of-scope worktree', () => {
    const stale = staleDirectSshSnapshotTabIds(
      tabsByWorktree({ [OTHER_WT]: [tab('tab-fresh', OTHER_WT)] }),
      new Set([WT]),
      new Set(['tab-fresh'])
    )
    expect(stale).toEqual(['tab-fresh'])
  })
})

describe('graftLocalTabsIntoRemoteSession', () => {
  function session(tabs: WorkspaceSessionState['tabsByWorktree']): WorkspaceSessionState {
    return {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: tabs,
      terminalLayoutsByTabId: {}
    }
  }

  it('returns the session unchanged when there is nothing to graft', () => {
    const remote = session({ [WT]: [tab('tab-remote', WT)] })
    expect(graftLocalTabsIntoRemoteSession(remote, new Set([WT]), {}, new Set())).toBe(remote)
  })

  it('appends the named local tabs after the remote tabs of their worktree', () => {
    const remote = session({ [WT]: [tab('tab-remote', WT)] })
    const local = { [WT]: [tab('tab-old', WT), tab('tab-fresh', WT)] }
    const grafted = graftLocalTabsIntoRemoteSession(
      remote,
      new Set([WT]),
      local,
      new Set(['tab-fresh'])
    )
    expect(grafted.tabsByWorktree[WT].map((t) => t.id)).toEqual(['tab-remote', 'tab-fresh'])
    expect(remote.tabsByWorktree[WT].map((t) => t.id)).toEqual(['tab-remote'])
  })

  it('grafts into a worktree the snapshot has no entry for', () => {
    const remote = session({})
    const grafted = graftLocalTabsIntoRemoteSession(
      remote,
      new Set([WT]),
      { [WT]: [tab('tab-fresh', WT)] },
      new Set(['tab-fresh'])
    )
    expect(grafted.tabsByWorktree[WT].map((t) => t.id)).toEqual(['tab-fresh'])
  })

  it('leaves out-of-scope worktrees untouched', () => {
    const remote = session({ [OTHER_WT]: [tab('tab-other', OTHER_WT)] })
    const grafted = graftLocalTabsIntoRemoteSession(
      remote,
      new Set([WT]),
      { [OTHER_WT]: [tab('tab-fresh', OTHER_WT)] },
      new Set(['tab-fresh'])
    )
    expect(grafted.tabsByWorktree[OTHER_WT].map((t) => t.id)).toEqual(['tab-other'])
    expect(grafted.tabsByWorktree[WT]).toBeUndefined()
  })
})
