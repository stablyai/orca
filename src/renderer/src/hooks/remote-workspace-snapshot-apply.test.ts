import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  graftLocalTabsIntoRemoteSession,
  postBoundaryLocalTabIds
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

describe('postBoundaryLocalTabIds', () => {
  it('returns nothing when there are no local tabs', () => {
    expect(postBoundaryLocalTabIds(tabsByWorktree({}), new Set([WT]), {}, new Set())).toEqual([])
  })

  it('returns nothing when every new local tab is listed in the snapshot', () => {
    const local = { [WT]: [tab('tab-1', WT)] }
    const postBoundary = postBoundaryLocalTabIds(
      tabsByWorktree({ [WT]: [tab('tab-1', WT), tab('tab-2', WT)] }),
      new Set([WT]),
      local,
      new Set()
    )
    expect(postBoundary).toEqual([])
  })

  it('reports a new local tab the snapshot omits', () => {
    const postBoundary = postBoundaryLocalTabIds(
      tabsByWorktree({ [WT]: [tab('tab-old', WT)] }),
      new Set([WT]),
      { [WT]: [tab('tab-fresh', WT)] },
      new Set()
    )
    expect(postBoundary).toEqual(['tab-fresh'])
  })

  it('does not report a preexisting live tab omitted by a newer snapshot', () => {
    const postBoundary = postBoundaryLocalTabIds(
      tabsByWorktree({}),
      new Set([WT]),
      { [WT]: [tab('tab-existing', WT)] },
      new Set(['tab-existing'])
    )
    expect(postBoundary).toEqual([])
  })

  it('ignores new local tabs outside the target scope', () => {
    const postBoundary = postBoundaryLocalTabIds(
      tabsByWorktree({ [OTHER_WT]: [tab('tab-fresh', OTHER_WT)] }),
      new Set([WT]),
      { [OTHER_WT]: [tab('tab-fresh', OTHER_WT)] },
      new Set()
    )
    expect(postBoundary).toEqual([])
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
