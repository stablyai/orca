import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from '../../../shared/remote-workspace-session-projection'
import type {
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../../../shared/types'
import {
  mergeDirectSshRemoteWorkspaceSession,
  uniqueWorktreeIdByPath
} from './remote-workspace-session-merge'

// Why this file exists: the host answers "this worktree has no tabs" two different ways — an
// explicit empty list (the user closed the last tab) and an absent key (the host never knew about
// this worktree). Those demand opposite handling, and every bug in this area comes from collapsing
// them. These tests pin both directions so neither fix can be traded for the other.

const REPO = 'repo-1'
const WT_A = `${REPO}::/srv/wt-a`
const WT_B = `${REPO}::/srv/wt-b`

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    ptyIdsByLeafId: {},
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

function sessionWith(tabsByWorktree: Record<string, TerminalTab[]>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree }
}

/** Drives the real wire path so the empty-vs-absent distinction is proven end to end, not assumed. */
function pullFromHost(
  hostSession: WorkspaceSessionState,
  clientSession: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>
): WorkspaceSessionState {
  const wire = JSON.parse(
    JSON.stringify(
      exportRemoteWorkspaceSession(hostSession, {
        isTargetWorktree: () => true
      })
    )
  ) as ReturnType<typeof exportRemoteWorkspaceSession>
  const remote = importRemoteWorkspaceSession(wire, {
    resolveWorktreeId: uniqueWorktreeIdByPath(replaceWorktreeIds)
  })
  return mergeDirectSshRemoteWorkspaceSession(
    clientSession,
    remote,
    replaceWorktreeIds,
    clientSession.tabsByWorktree,
    new Set()
  )
}

describe('direct SSH snapshot tab authority', () => {
  it('keeps an empty tab list distinct from an absent worktree across the wire', () => {
    const wire = JSON.parse(
      JSON.stringify(
        exportRemoteWorkspaceSession(sessionWith({ [WT_A]: [], [WT_B]: [tab('t1', WT_B)] }), {
          isTargetWorktree: () => true
        })
      )
    ) as ReturnType<typeof exportRemoteWorkspaceSession>
    // The whole design rests on this surviving JSON: '/srv/wt-a' present-but-empty, '/srv/wt-c' absent.
    expect(wire.tabsByWorktreePath['/srv/wt-a']).toEqual([])
    expect(Object.hasOwn(wire.tabsByWorktreePath, '/srv/wt-a')).toBe(true)
    expect(Object.hasOwn(wire.tabsByWorktreePath, '/srv/wt-c')).toBe(false)

    const remote = importRemoteWorkspaceSession(wire, {
      resolveWorktreeId: uniqueWorktreeIdByPath(new Set([WT_A, WT_B]))
    })
    expect(Object.hasOwn(remote.tabsByWorktree, WT_A)).toBe(true)
    expect(remote.tabsByWorktree[WT_A]).toEqual([])
  })

  // The reported P0: the host has no record of this worktree, and the client's visible tabs vanish.
  it('preserves local tabs when the host snapshot omits the worktree entirely', () => {
    const merged = pullFromHost(
      sessionWith({ [WT_A]: [tab('a1', WT_A)] }),
      sessionWith({ [WT_A]: [tab('a1', WT_A)], [WT_B]: [tab('b1', WT_B)] }),
      new Set([WT_A, WT_B])
    )
    expect(merged.tabsByWorktree[WT_B]?.map((t) => t.id)).toEqual(['b1'])
  })

  // The regression a "protect whenever local has tabs" heuristic introduces: closing the last tab
  // on one client must not be undone by the next pull on another.
  it('honors an explicit empty tab list so a closed tab does not come back', () => {
    const merged = pullFromHost(
      sessionWith({ [WT_A]: [tab('a1', WT_A)], [WT_B]: [] }),
      sessionWith({ [WT_A]: [tab('a1', WT_A)], [WT_B]: [tab('b1', WT_B)] }),
      new Set([WT_A, WT_B])
    )
    expect(merged.tabsByWorktree[WT_B] ?? []).toEqual([])
  })

  it('honors an empty list even when it empties every worktree in scope', () => {
    const merged = pullFromHost(
      sessionWith({ [WT_A]: [], [WT_B]: [] }),
      sessionWith({ [WT_A]: [tab('a1', WT_A)], [WT_B]: [tab('b1', WT_B)] }),
      new Set([WT_A, WT_B])
    )
    expect(merged.tabsByWorktree[WT_A] ?? []).toEqual([])
    expect(merged.tabsByWorktree[WT_B] ?? []).toEqual([])
  })

  it('drops layout and remote-session records only for worktrees the host actually emptied', () => {
    const client: WorkspaceSessionState = {
      ...sessionWith({ [WT_A]: [tab('a1', WT_A)], [WT_B]: [tab('b1', WT_B)] }),
      terminalLayoutsByTabId: {
        a1: layout('l-a1'),
        b1: layout('l-b1')
      },
      remoteSessionIdsByTabId: { a1: 'rs-a1', b1: 'rs-b1' }
    }
    // Host emptied A (explicit) and never knew B (absent).
    const merged = pullFromHost(sessionWith({ [WT_A]: [] }), client, new Set([WT_A, WT_B]))
    expect(merged.terminalLayoutsByTabId.a1).toBeUndefined()
    expect(merged.remoteSessionIdsByTabId?.a1).toBeUndefined()
    expect(merged.terminalLayoutsByTabId.b1).toBeDefined()
    expect(merged.remoteSessionIdsByTabId?.b1).toBe('rs-b1')
  })

  it('leaves worktrees outside the replace scope untouched in both shapes', () => {
    const merged = pullFromHost(
      sessionWith({ [WT_A]: [] }),
      sessionWith({ [WT_A]: [tab('a1', WT_A)], [WT_B]: [tab('b1', WT_B)] }),
      new Set([WT_A])
    )
    expect(merged.tabsByWorktree[WT_A] ?? []).toEqual([])
    expect(merged.tabsByWorktree[WT_B]?.map((t) => t.id)).toEqual(['b1'])
  })
})
