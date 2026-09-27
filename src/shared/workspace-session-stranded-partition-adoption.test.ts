import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { Tab, TabGroup } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { adoptStrandedHostPartitionSession } from './workspace-session-stranded-partition-adoption'

const WORKTREE_ID = 'repo-remote::/remote/checkout/feature'

function tab(id: string, ptyId: string | null = `pty-${id}`): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function unified(id: string, groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function group(id: string, tabOrder: string[]): TabGroup {
  return {
    id,
    worktreeId: WORKTREE_ID,
    activeTabId: tabOrder[0] ?? null,
    tabOrder,
    recentTabIds: []
  }
}

function session(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function tombstones(
  ...tabIds: string[]
): WorkspaceSessionState['closedTerminalTabTombstonesByTabId'] {
  return Object.fromEntries(tabIds.map((id) => [id, { closedAt: 1, worktreeId: WORKTREE_ID }]))
}

type OwnershipCase = {
  name: string
  base: TerminalTab[]
  /** null: the host names the workspace but holds no tab row for it. */
  host: TerminalTab[] | null
  hostTombstones: string[]
  expected: string[]
  adopted: boolean
}

const OWNERSHIP_CASES: OwnershipCase[] = [
  {
    name: 'local empty, host populated: adopts the host tabs',
    base: [],
    host: [tab('h1')],
    hostTombstones: [],
    expected: ['h1'],
    adopted: true
  },
  {
    name: 'both populated with disjoint ids: host replaces the PTY-less local leftovers',
    base: [tab('l1', null), tab('l2', null)],
    host: [tab('h1'), tab('h2')],
    hostTombstones: [],
    expected: ['h1', 'h2'],
    adopted: true
  },
  {
    name: 'both hold the same tab: the host copy wins',
    base: [{ ...tab('shared'), title: 'Terminal 3' }],
    host: [{ ...tab('shared'), title: 'claude' }],
    hostTombstones: [],
    expected: ['shared'],
    adopted: true
  },
  {
    name: 'a local tab the host tombstoned never comes back, even with a PTY',
    base: [tab('closed')],
    host: [tab('h1')],
    hostTombstones: ['closed'],
    expected: ['h1'],
    adopted: true
  },
  {
    name: 'a local tab that still names a PTY the host never listed is kept',
    base: [tab('live-local')],
    host: [tab('h1')],
    hostTombstones: [],
    expected: ['h1', 'live-local'],
    adopted: true
  },
  {
    name: 'a PTY-less local tab newer than every host row is kept (parked on an unresolved host)',
    base: [{ ...tab('parked', null), createdAt: 50 }],
    host: [{ ...tab('h1'), createdAt: 10 }],
    hostTombstones: [],
    expected: ['h1', 'parked'],
    adopted: true
  },
  {
    name: 'PTY-less local tabs older than the host rows are residue and dropped (#22503)',
    base: [
      { ...tab('old1', null), createdAt: 5 },
      { ...tab('old2', null), createdAt: 9 }
    ],
    host: [{ ...tab('h1'), createdAt: 10 }],
    hostTombstones: [],
    expected: ['h1'],
    adopted: true
  },
  {
    name: 'a tombstone beats a newer PTY-less local tab',
    base: [{ ...tab('parked', null), createdAt: 50 }],
    host: [{ ...tab('h1'), createdAt: 10 }],
    hostTombstones: ['parked'],
    expected: ['h1'],
    adopted: true
  },
  {
    name: 'only local populated: the base keeps its own copy',
    base: [tab('l1')],
    host: null,
    hostTombstones: [],
    expected: ['l1'],
    adopted: false
  },
  {
    name: 'host row explicitly empty: the base keeps its tabs',
    base: [tab('l1')],
    host: [],
    hostTombstones: [],
    expected: ['l1'],
    adopted: false
  }
]

describe('adoptStrandedHostPartitionSession terminal tab ownership', () => {
  it.each(OWNERSHIP_CASES)('$name', ({ base, host, hostTombstones, expected, adopted }) => {
    const hostSession = session({
      tabsByWorktree: host === null ? {} : { [WORKTREE_ID]: host },
      // Names the workspace even when it holds no tab row, as an editor-only host row would.
      activeTabTypeByWorktree: { [WORKTREE_ID]: 'terminal' },
      closedTerminalTabTombstonesByTabId: tombstones(...hostTombstones)
    })

    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: base } }),
      hostSession
    )

    expect(result.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(expected)
    expect(result.adoptedWorkspaceIds.has(WORKTREE_ID)).toBe(adopted)
  })

  it('bounds a PTY-less local tab by the newest host close, not only the newest host tab', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [{ ...tab('l1', null), createdAt: 20 }] } }),
      session({
        tabsByWorktree: { [WORKTREE_ID]: [{ ...tab('h1'), createdAt: 10 }] },
        closedTerminalTabTombstonesByTabId: {
          other: { closedAt: 30, worktreeId: WORKTREE_ID }
        }
      })
    )

    expect(result.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['h1'])
  })

  it('keeps the host title for a tab both partitions hold', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [{ ...tab('shared'), title: 'Terminal 3' }] } }),
      session({ tabsByWorktree: { [WORKTREE_ID]: [{ ...tab('shared'), title: 'claude' }] } })
    )

    expect(result.session.tabsByWorktree[WORKTREE_ID]?.[0]?.title).toBe('claude')
  })

  it('takes the host unified rows over a local copy that has none (#23390)', () => {
    const result = adoptStrandedHostPartitionSession(
      session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('agent')] },
        unifiedTabs: {},
        tabGroups: {}
      }),
      session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('agent')] },
        unifiedTabs: { [WORKTREE_ID]: [unified('agent', 'g1')] },
        tabGroups: { [WORKTREE_ID]: [group('g1', ['agent'])] }
      })
    )

    expect(result.session.unifiedTabs?.[WORKTREE_ID]?.map((entry) => entry.entityId)).toEqual([
      'agent'
    ])
    expect(result.session.tabGroups?.[WORKTREE_ID]?.[0]?.tabOrder).toEqual(['agent'])
  })

  it('gives a carried local terminal a unified entry in the host group', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('live-local')] }, unifiedTabs: {} }),
      session({
        tabsByWorktree: { [WORKTREE_ID]: [tab('h1')] },
        unifiedTabs: { [WORKTREE_ID]: [unified('h1', 'g1')] },
        tabGroups: { [WORKTREE_ID]: [group('g1', ['h1'])] },
        activeGroupIdByWorktree: { [WORKTREE_ID]: 'g1' }
      })
    )

    expect(
      result.session.unifiedTabs?.[WORKTREE_ID]?.map((entry) => [entry.entityId, entry.groupId])
    ).toEqual([
      ['h1', 'g1'],
      ['live-local', 'g1']
    ])
  })

  it('still lets a contested id keep its own populated base row', () => {
    const result = adoptStrandedHostPartitionSession(
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('l1', null)] } }),
      session({ tabsByWorktree: { [WORKTREE_ID]: [tab('h1')] } }),
      { contestedSessionKeys: new Set([WORKTREE_ID]) }
    )

    expect(result.session.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['l1'])
    expect(result.adoptedWorkspaceIds.has(WORKTREE_ID)).toBe(false)
  })
})
