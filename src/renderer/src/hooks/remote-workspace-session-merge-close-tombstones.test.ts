import { describe, expect, it } from 'vitest'

import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'

/**
 * The one thing a close tombstone is allowed to do, and everything it is not.
 *
 * The bug it exists for: the `pty.kill` for a closed SSH tab rejects with a transport error, so the
 * close never reaches the host, the host keeps listing the tab, and every reconnect re-inserts it.
 * The bug it must never cause is the opposite one — PR #14361 was reverted for deleting live tabs —
 * so every case below that is not "an id this client watched the user close" keeps the tab.
 */
const WORKTREE = 'repo-1::/home/user/bug-cats'

function terminalTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id, title: id, type: 'terminal', worktreeId: WORKTREE, ...overrides } as TerminalTab
}

function sessionState(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE),
    activeTabId: 'agent',
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    ...overrides
  } as WorkspaceSessionState
}

function merge(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  liveTabs: AppState['tabsByWorktree'] = {},
  remoteRevision?: number
): WorkspaceSessionState {
  return mergeDirectSshRemoteWorkspaceSession(
    current,
    remote,
    new Set([WORKTREE]),
    liveTabs,
    new Set(),
    undefined,
    remoteRevision
  )
}

function tombstone(tabId: string, ackRevision?: number): WorkspaceSessionState {
  return sessionState({
    tabsByWorktree: { [WORKTREE]: [] },
    closedTerminalTabTombstonesByTabId: {
      [tabId]: {
        closedAt: Date.now(),
        worktreeId: WORKTREE,
        ...(ackRevision ? { ackRevision } : {})
      }
    }
  })
}

describe('direct-SSH pull merge: closed-tab tombstones', () => {
  it('does not suppress a host tab whose id collides with an Object.prototype key', () => {
    // `tabId in map` answers true for every prototype key even on an EMPTY map, so a host tab named
    // `toString` was filtered out, blocked from the host-unknown branch, and stripped of its layout
    // and session id — the one path in this function that could delete a tab the user never closed.
    // Tab ids are validated only as non-empty and colon-free, and createTab honours caller-supplied
    // id hints, so the id is reachable rather than theoretical.
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [] } })
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [terminalTab('toString')] },
      terminalLayoutsByTabId: { toString: { root: { type: 'leaf', paneId: 'p' } } as never },
      remoteSessionIdsByTabId: { toString: 'session-1' }
    })

    const merged = merge(current, remote, {}, 2)

    expect(merged.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['toString'])
    expect(Object.hasOwn(merged.terminalLayoutsByTabId, 'toString')).toBe(true)
    expect(merged.remoteSessionIdsByTabId?.toString).toBe('session-1')
  })

  it('does not suppress a tombstoned id under a DIFFERENT worktree', () => {
    // The tombstone carries the worktree it was closed in, so suppression cannot reach another
    // workspace's tab. Structural, rather than a property of where the call sites happen to sit.
    const other = 'repo-1::/home/user/other'
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [] },
      closedTerminalTabTombstonesByTabId: {
        'tab-x': { closedAt: Date.now(), worktreeId: other }
      }
    })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [terminalTab('tab-x')] } })

    const merged = merge(current, remote, {}, 2)

    expect(merged.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-x'])
  })

  it('does not re-insert a tombstoned tab the host still lists', () => {
    const ghost = terminalTab('ghost')
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [ghost] },
      terminalLayoutsByTabId: { ghost: { type: 'single', tabId: 'ghost' } as never },
      remoteSessionIdsByTabId: { ghost: 'pty-1' }
    })

    const merged = merge(tombstone('ghost'), remote, { [WORKTREE]: [] }, 3)

    expect(merged.tabsByWorktree[WORKTREE]).toEqual([])
    expect(merged.terminalLayoutsByTabId.ghost).toBeUndefined()
    expect(merged.remoteSessionIdsByTabId?.ghost).toBeUndefined()
    expect(merged.closedTerminalTabTombstonesByTabId?.ghost).toBeDefined()
  })

  it('does not re-add a tombstoned tab through the host-unknown branch', () => {
    // The stale persisted payload still lists it, and the host has never heard of it. Without the
    // tombstone that combination is exactly what the host-unknown branch exists to preserve.
    const ghost = terminalTab('ghost')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [ghost] },
      closedTerminalTabTombstonesByTabId: { ghost: { closedAt: Date.now(), worktreeId: WORKTREE } }
    })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [] } })

    const merged = merge(current, remote, {}, 3)

    expect(merged.tabsByWorktree[WORKTREE]).toEqual([])
  })

  it('suppresses only the tombstoned tab, leaving its siblings and the pointers alone', () => {
    // The active-tab pointers deliberately still name the ghost: hydration validates both of them
    // against the rows below and nulls what they no longer name, so the merge leaves them be.
    const ghost = terminalTab('ghost')
    const survivor = terminalTab('survivor')
    const remote = sessionState({
      tabsByWorktree: { [WORKTREE]: [ghost, survivor] },
      activeTabId: 'ghost',
      activeTabIdByWorktree: { [WORKTREE]: 'ghost' }
    })

    const merged = merge(tombstone('ghost'), remote, { [WORKTREE]: [] }, 3)

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['survivor'])
  })

  it('a live local tab beats a stale tombstone for its id', () => {
    const live = terminalTab('live')
    const current = sessionState({
      tabsByWorktree: { [WORKTREE]: [live] },
      closedTerminalTabTombstonesByTabId: { live: { closedAt: Date.now(), worktreeId: WORKTREE } }
    })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [live] } })

    const merged = merge(current, remote, { [WORKTREE]: [live] }, 3)

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['live'])
  })

  it('leaves a tab alone when no tombstone names it', () => {
    // The pre-existing absence-is-not-closed trade, restated: a host that still lists a tab closed
    // on some other client keeps it here, because absence is all this merge would have to go on.
    const agent = terminalTab('agent')
    const closedElsewhere = terminalTab('closed-elsewhere')
    const current = sessionState({ tabsByWorktree: { [WORKTREE]: [agent, closedElsewhere] } })
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [agent] } })

    const merged = merge(current, remote, { [WORKTREE]: [agent, closedElsewhere] }, 3)

    expect(merged.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('retires the tombstone once a newer snapshot stops listing the tab', () => {
    const remote = sessionState({ tabsByWorktree: { [WORKTREE]: [] } })

    const merged = merge(tombstone('ghost', 3), remote, { [WORKTREE]: [] }, 4)

    expect(merged.closedTerminalTabTombstonesByTabId).toBeUndefined()
  })

  it('keeps the tombstone when the snapshot omits the worktree entirely', () => {
    // A snapshot that says nothing about the worktree — including one whose path never resolved —
    // is not evidence the host saw the close.
    const merged = merge(tombstone('ghost', 3), sessionState(), {}, 4)

    expect(merged.closedTerminalTabTombstonesByTabId?.ghost).toBeDefined()
  })
})
