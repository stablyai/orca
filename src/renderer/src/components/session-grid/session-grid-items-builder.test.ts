import { beforeEach, describe, expect, it } from 'vitest'
import { buildSessionGridListing, type SessionGridItemsState } from './session-grid-items-builder'
import { createSessionGridItemReuseCache } from './session-grid-item-reuse-cache'
import { buildSessionGridWorktreeCatalog } from './session-grid-worktree-catalog'
import { resetTerminalTabActivityFlagsCacheForTest } from '@/components/tab-bar/terminal-tab-activity-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'
const LEAF_D = '44444444-4444-4444-8444-444444444444'

const catalog = buildSessionGridWorktreeCatalog({
  repos: [{ id: 'repo-1', displayName: 'orca', path: '/code/orca' } as unknown as Repo],
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', displayName: 'orca', branch: 'main' } as unknown as Worktree]
  }
})

function tab(id: string, ptyId: string, createdAt: number): TerminalTab {
  return { id, ptyId, worktreeId: 'wt-1', title: id, createdAt } as TerminalTab
}

function statusEntry(
  paneKey: string,
  state: 'working' | 'blocked' | 'done',
  updatedAt: number
): AgentStatusEntry {
  return {
    paneKey,
    state,
    agentType: 'claude',
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt
  } as unknown as AgentStatusEntry
}

function workingEntry(paneKey: string, updatedAt: number): AgentStatusEntry {
  return statusEntry(paneKey, 'working', updatedAt)
}

/** One card per bucket: blocked → attention, working → working, done → done, no entry → idle. */
function makeBucketState(overrides: Partial<SessionGridItemsState> = {}): SessionGridItemsState {
  const now = Date.now()
  const leaves = { 'tab-a': LEAF_A, 'tab-b': LEAF_B, 'tab-c': LEAF_C, 'tab-d': LEAF_D }
  return makeState({
    tabsByWorktree: {
      'wt-1': [
        tab('tab-a', 'pty-a', 1),
        tab('tab-b', 'pty-b', 2),
        tab('tab-c', 'pty-c', 3),
        tab('tab-d', 'pty-d', 4)
      ]
    },
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(leaves).map(([tabId, leaf]) => [
        tabId,
        { activeLeafId: leaf, ptyIdsByLeafId: { [leaf]: `pty-${tabId.slice(-1)}` } }
      ])
    ) as never,
    ptyIdsByTabId: {
      'tab-a': ['pty-a'],
      'tab-b': ['pty-b'],
      'tab-c': ['pty-c'],
      'tab-d': ['pty-d']
    },
    agentStatusByPaneKey: {
      [`tab-a:${LEAF_A}`]: statusEntry(`tab-a:${LEAF_A}`, 'blocked', now),
      [`tab-b:${LEAF_B}`]: statusEntry(`tab-b:${LEAF_B}`, 'working', now),
      [`tab-c:${LEAF_C}`]: statusEntry(`tab-c:${LEAF_C}`, 'done', now)
    },
    agentStatusEpoch: 1,
    ...overrides
  })
}

function makeState(overrides: Partial<SessionGridItemsState> = {}): SessionGridItemsState {
  return {
    tabsByWorktree: { 'wt-1': [tab('tab-a', 'pty-a', 1), tab('tab-b', 'pty-b', 2)] },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      'tab-a': { activeLeafId: LEAF_A, ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } },
      'tab-b': { activeLeafId: LEAF_B, ptyIdsByLeafId: { [LEAF_B]: 'pty-b' } }
    } as never,
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    runtimePaneTitlesByTabId: {},
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {},
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
    generatedTitlesEnabled: false,
    revealHidden: false,
    ...overrides
  }
}

describe('buildSessionGridListing', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('keeps the object of a card an agent-status burst did not touch', () => {
    const cache = createSessionGridItemReuseCache()
    const before = buildSessionGridListing(makeState(), catalog, cache)
    const [cardA, cardB] = before.allItems

    // A burst that only moves tab-b: a new status map, a new epoch, same tab-a.
    resetTerminalTabActivityFlagsCacheForTest()
    const after = buildSessionGridListing(
      makeState({
        agentStatusByPaneKey: { [`tab-b:${LEAF_B}`]: workingEntry(`tab-b:${LEAF_B}`, Date.now()) },
        agentStatusEpoch: 1
      }),
      catalog,
      cache
    )

    expect(after.allItems[0]).toBe(cardA)
    expect(after.allItems[1]).not.toBe(cardB)
    expect(after.allItems[1]?.dotState).toBe('working')
    // The list changed, so the array must not be reused.
    expect(after.allItems).not.toBe(before.allItems)
  })

  it('keeps the list array when nothing moved at all', () => {
    const cache = createSessionGridItemReuseCache()
    const before = buildSessionGridListing(makeState(), catalog, cache)
    const after = buildSessionGridListing(makeState(), catalog, cache)

    expect(after.allItems).toBe(before.allItems)
    expect(after.items).toBe(before.items)
  })

  it('reuses the filtered list independently of the full one', () => {
    const cache = createSessionGridItemReuseCache()
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [tab('tab-a', 'pty-a', 1)],
        'wt-2': [tab('tab-c', 'pty-c', 3)]
      },
      ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-c': ['pty-c'] },
      sessionsGridFilter: 'wt-1'
    })
    const before = buildSessionGridListing(state, catalog, cache)
    expect(before.items.map((i) => i.tabId)).toEqual(['tab-a'])
    expect(before.items).not.toBe(before.allItems)

    const after = buildSessionGridListing(state, catalog, cache)
    expect(after.items).toBe(before.items)
    expect(after.allItems).toBe(before.allItems)
  })

  it('drops a closed tab from the cache instead of retaining it for the session', () => {
    const cache = createSessionGridItemReuseCache()
    buildSessionGridListing(makeState(), catalog, cache)
    expect([...cache.previousByTabId.keys()]).toEqual(['tab-a', 'tab-b'])

    buildSessionGridListing(
      makeState({
        tabsByWorktree: { 'wt-1': [tab('tab-a', 'pty-a', 1)] },
        ptyIdsByTabId: { 'tab-a': ['pty-a'] }
      }),
      catalog,
      cache
    )

    expect([...cache.previousByTabId.keys()]).toEqual(['tab-a'])
  })

  it('builds the same listing with no cache at all', () => {
    const withCache = buildSessionGridListing(
      makeState(),
      catalog,
      createSessionGridItemReuseCache()
    )
    const withoutCache = buildSessionGridListing(makeState(), catalog)
    expect(withoutCache).toEqual(withCache)
  })
})

describe('state-filter axis', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('paints every card in the bucket it says it has, and no other', () => {
    const listing = buildSessionGridListing(makeBucketState(), catalog)
    expect(listing.allItems.map((i) => i.dotState)).toEqual([
      'permission',
      'working',
      'done',
      'idle'
    ])
    expect(listing.stateCounts).toEqual({ attention: 1, working: 1, done: 1, idle: 1 })
  })

  it('selects exactly the cards each bucket counted', () => {
    for (const [filter, tabId] of [
      ['attention', 'tab-a'],
      ['working', 'tab-b'],
      ['done', 'tab-c'],
      ['idle', 'tab-d']
    ] as const) {
      resetTerminalTabActivityFlagsCacheForTest()
      const listing = buildSessionGridListing(
        makeBucketState({ sessionsGridStateFilter: filter }),
        catalog
      )
      expect(listing.items.map((i) => i.tabId)).toEqual([tabId])
      expect(listing.stateCounts[filter]).toBe(listing.items.length)
      // The other axis is untouched: the workspace chip still counts the whole workspace.
      expect(listing.filterOptions.find((o) => o.id === 'wt-1')?.count).toBe(4)
      expect(listing.allItems).toHaveLength(4)
    }
  })

  it('counts the state buckets under the workspace filter, not across it', () => {
    const listing = buildSessionGridListing(
      makeBucketState({
        tabsByWorktree: {
          'wt-1': [tab('tab-a', 'pty-a', 1)],
          'wt-2': [{ ...tab('tab-z', 'pty-z', 2), worktreeId: 'wt-2' }]
        },
        ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-z': ['pty-z'] },
        sessionsGridFilter: 'wt-1'
      }),
      catalog
    )
    // tab-z is idle and in another workspace: it must not swell the idle chip.
    expect(listing.stateCounts).toEqual({ attention: 1, working: 0, done: 0, idle: 0 })
    expect(listing.allItems).toHaveLength(2)
  })
})

describe('hidden cards', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('drops a hidden card from items while leaving the drag order intact', () => {
    const before = buildSessionGridListing(makeState(), catalog)
    expect(before.items.map((i) => i.tabId)).toEqual(['tab-a', 'tab-b'])

    const listing = buildSessionGridListing(
      makeState({ sessionsGridHiddenTabIds: ['tab-a'] }),
      catalog
    )
    expect(listing.items.map((i) => i.tabId)).toEqual(['tab-b'])
    // E-17: the drag order is built from allItems, so a hidden card must stay in it.
    expect(listing.allItems.map((i) => i.tabId)).toEqual(['tab-a', 'tab-b'])
    expect(listing.allItems[0]?.isHiddenFromGrid).toBe(true)
    expect(listing.allItems[1]?.isHiddenFromGrid).toBe(false)
    expect(listing.hiddenCount).toBe(1)
  })

  it('puts them back, in their own places, while revealing', () => {
    const listing = buildSessionGridListing(
      makeState({ sessionsGridHiddenTabIds: ['tab-a'], revealHidden: true }),
      catalog
    )
    expect(listing.items.map((i) => i.tabId)).toEqual(['tab-a', 'tab-b'])
    expect(listing.hiddenCount).toBe(1)
  })

  it('keeps a hidden card out of the bucket tallies until it is revealed', () => {
    const hidden = buildSessionGridListing(
      makeBucketState({ sessionsGridHiddenTabIds: ['tab-b'] }),
      catalog
    )
    expect(hidden.stateCounts.working).toBe(0)
    expect(hidden.items.map((i) => i.tabId)).not.toContain('tab-b')

    resetTerminalTabActivityFlagsCacheForTest()
    const revealed = buildSessionGridListing(
      makeBucketState({ sessionsGridHiddenTabIds: ['tab-b'], revealHidden: true }),
      catalog
    )
    expect(revealed.stateCounts.working).toBe(1)
  })

  it('counts hidden cards per workspace, so a state chip cannot bury the reveal chip', () => {
    // Filtered to a bucket tab-b is not in, the reveal chip still reports it.
    const listing = buildSessionGridListing(
      makeBucketState({ sessionsGridHiddenTabIds: ['tab-b'], sessionsGridStateFilter: 'idle' }),
      catalog
    )
    expect(listing.items.map((i) => i.tabId)).toEqual(['tab-d'])
    expect(listing.hiddenCount).toBe(1)
  })

  /**
   * The chip counted it, so pressing the chip has to show it. Counting a `working` hidden card
   * under an `idle` state filter and then keeping that same filter over the reveal left the
   * user with "Hidden 1", an active chip, no card, and no way to un-hide it from the grid at
   * all. Revealing is not a query on the state axis — it is "show me what I put away" — so a
   * revealed card is shown on top of whatever the state chip selected.
   */
  it('shows the hidden card the reveal chip counted, whatever the state chip says', () => {
    const revealed = buildSessionGridListing(
      makeBucketState({
        sessionsGridHiddenTabIds: ['tab-b'],
        sessionsGridStateFilter: 'idle',
        revealHidden: true
      }),
      catalog
    )

    expect(revealed.items.map((i) => i.tabId)).toEqual(['tab-b', 'tab-d'])
    expect(revealed.hiddenCount).toBe(1)
  })

  it('still hides what the state chip excludes once revealing stops', () => {
    const revealed = buildSessionGridListing(
      makeBucketState({
        sessionsGridHiddenTabIds: ['tab-b'],
        sessionsGridStateFilter: 'idle',
        revealHidden: true
      }),
      catalog
    )
    expect(revealed.items.map((i) => i.tabId)).toContain('tab-b')

    resetTerminalTabActivityFlagsCacheForTest()
    // tab-c is `done` and never hidden: the state chip still owns every card the user kept.
    const notRevealed = buildSessionGridListing(
      makeBucketState({
        sessionsGridHiddenTabIds: ['tab-b'],
        sessionsGridStateFilter: 'idle'
      }),
      catalog
    )
    expect(notRevealed.items.map((i) => i.tabId)).toEqual(['tab-d'])
  })

  it('takes them off the workspace chips too, because hidden is a subtraction, not an axis', () => {
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [tab('tab-a', 'pty-a', 1), tab('tab-b', 'pty-b', 2)],
        'wt-2': [{ ...tab('tab-z', 'pty-z', 3), worktreeId: 'wt-2' }]
      },
      ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'], 'tab-z': ['pty-z'] },
      sessionsGridHiddenTabIds: ['tab-a']
    })
    const listing = buildSessionGridListing(state, catalog)
    // Two adjacent chips both reading "all" must not disagree: 2 painted, 2 counted.
    expect(listing.items).toHaveLength(2)
    expect(listing.filterOptions.find((o) => o.id === 'all')?.count).toBe(2)
    expect(listing.filterOptions.find((o) => o.id === 'wt-1')?.count).toBe(1)
    expect(listing.filterOptions.find((o) => o.id === 'wt-2')?.count).toBe(1)

    resetTerminalTabActivityFlagsCacheForTest()
    const revealed = buildSessionGridListing({ ...state, revealHidden: true }, catalog)
    expect(revealed.items).toHaveLength(3)
    expect(revealed.filterOptions.find((o) => o.id === 'all')?.count).toBe(3)
    expect(revealed.filterOptions.find((o) => o.id === 'wt-1')?.count).toBe(2)
  })

  it('does not count a hidden card from another workspace', () => {
    const listing = buildSessionGridListing(
      makeState({
        tabsByWorktree: {
          'wt-1': [tab('tab-a', 'pty-a', 1)],
          'wt-2': [{ ...tab('tab-z', 'pty-z', 2), worktreeId: 'wt-2' }]
        },
        ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-z': ['pty-z'] },
        sessionsGridFilter: 'wt-1',
        sessionsGridHiddenTabIds: ['tab-z']
      }),
      catalog
    )
    expect(listing.hiddenCount).toBe(0)
  })
})

describe('chip identity across a burst', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('hands back the same chips and tallies when nothing moved', () => {
    const cache = createSessionGridItemReuseCache()
    const before = buildSessionGridListing(makeState(), catalog, cache)
    resetTerminalTabActivityFlagsCacheForTest()
    // A burst that replaces the status map and bumps the epoch without moving a card.
    const after = buildSessionGridListing(
      makeState({ agentStatusByPaneKey: {}, agentStatusEpoch: 1 }),
      catalog,
      cache
    )
    expect(after.filterOptions).toBe(before.filterOptions)
    expect(after.stateCounts).toBe(before.stateCounts)
  })

  it('lets go of them the moment a count actually changes', () => {
    const cache = createSessionGridItemReuseCache()
    const before = buildSessionGridListing(makeState(), catalog, cache)
    resetTerminalTabActivityFlagsCacheForTest()
    const after = buildSessionGridListing(
      makeState({
        agentStatusByPaneKey: { [`tab-b:${LEAF_B}`]: workingEntry(`tab-b:${LEAF_B}`, Date.now()) },
        agentStatusEpoch: 1
      }),
      catalog,
      cache
    )
    expect(after.stateCounts).not.toBe(before.stateCounts)
    expect(after.stateCounts).toEqual({ attention: 0, working: 1, done: 0, idle: 1 })
  })
})

/**
 * `resolveTerminalTabAttentionBadge`'s order is not the intuitive one:
 * working → permission → monitoring → unread → done → interrupted. Unread outranks a
 * finished turn but loses to anything live, and these pin that on the grid's own path.
 */
describe('attention badge', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('rings the bell for a tab marked unread', () => {
    const listing = buildSessionGridListing(
      makeState({ unreadTerminalTabs: { 'tab-a': true } }),
      catalog
    )
    expect(listing.allItems[0]?.hasUnread).toBe(true)
    expect(listing.allItems[0]?.attentionBadge).toBe('unread')
    // The quiet sibling stays quiet: unread is per tab, not per listing.
    expect(listing.allItems[1]?.hasUnread).toBe(false)
    expect(listing.allItems[1]?.attentionBadge).toBeNull()
  })

  it('rings it for an unacked agent completion pane, keyed by its tab', () => {
    const listing = buildSessionGridListing(
      makeState({ unreadAgentCompletionPanes: { [`tab-b:${LEAF_B}`]: true } }),
      catalog
    )
    expect(listing.allItems.map((i) => i.attentionBadge)).toEqual([null, 'unread'])
  })

  it('lets a live turn outrank an older unread on the same card', () => {
    const now = Date.now()
    const listing = buildSessionGridListing(
      makeState({
        agentStatusByPaneKey: {
          [`tab-a:${LEAF_A}`]: workingEntry(`tab-a:${LEAF_A}`, now),
          [`tab-b:${LEAF_B}`]: statusEntry(`tab-b:${LEAF_B}`, 'blocked', now)
        },
        agentStatusEpoch: 1,
        unreadTerminalTabs: { 'tab-a': true, 'tab-b': true }
      }),
      catalog
    )
    expect(listing.allItems.map((i) => i.attentionBadge)).toEqual(['working', 'permission'])
    // The bell is still true underneath — the ladder ranked it, it did not erase it.
    expect(listing.allItems.every((i) => i.hasUnread)).toBe(true)
  })

  it('lets unread outrank a finished turn, which the dot state alone cannot say', () => {
    const now = Date.now()
    const listing = buildSessionGridListing(
      makeState({
        agentStatusByPaneKey: { [`tab-a:${LEAF_A}`]: statusEntry(`tab-a:${LEAF_A}`, 'done', now) },
        agentStatusEpoch: 1,
        unreadTerminalTabs: { 'tab-a': true }
      }),
      catalog
    )
    expect(listing.allItems[0]?.dotState).toBe('done')
    expect(listing.allItems[0]?.attentionBadge).toBe('unread')
  })

  it('keeps the card object when only another card gains a bell', () => {
    const cache = createSessionGridItemReuseCache()
    const before = buildSessionGridListing(makeState(), catalog, cache)
    const [cardA, cardB] = before.allItems
    resetTerminalTabActivityFlagsCacheForTest()
    const after = buildSessionGridListing(
      makeState({ unreadTerminalTabs: { 'tab-b': true } }),
      catalog,
      cache
    )

    expect(after.allItems[0]).toBe(cardA)
    expect(after.allItems[1]).not.toBe(cardB)
  })
})

/**
 * The seam P3 flagged for P4 and P4 declined: the state chips read the dot state, the bell
 * reads unread, and neither moves the other. If a later plan folds them together, these two
 * fail first and say so.
 */
describe('attention and the state buckets are different questions', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('leaves an unread card in the bucket its dot state names', () => {
    const now = Date.now()
    const listing = buildSessionGridListing(
      makeState({
        agentStatusByPaneKey: { [`tab-a:${LEAF_A}`]: statusEntry(`tab-a:${LEAF_A}`, 'done', now) },
        agentStatusEpoch: 1,
        unreadTerminalTabs: { 'tab-a': true, 'tab-b': true }
      }),
      catalog
    )

    // The bell says unread; the chips still say one finished and one idle, not two attention.
    expect(listing.allItems.map((i) => i.attentionBadge)).toEqual(['unread', 'unread'])
    expect(listing.stateCounts).toEqual({ attention: 0, working: 0, done: 1, idle: 1 })
  })

  it('keeps a finished card in `done` after it has been seen', () => {
    const now = Date.now()
    const seen = makeState({
      agentStatusByPaneKey: { [`tab-a:${LEAF_A}`]: statusEntry(`tab-a:${LEAF_A}`, 'done', now) },
      agentStatusEpoch: 1
    })
    const listing = buildSessionGridListing(seen, catalog)

    // Acknowledgement is not even an input here — the builder has no way to read it — so a
    // `done` card stays in `done` until its status goes stale, attended or not.
    expect(listing.allItems[0]?.attentionBadge).toBe('done')
    expect(listing.stateCounts.done).toBe(1)
    expect(seen).not.toHaveProperty('acknowledgedAgentsByPaneKey')
  })
})

describe('buildSessionGridListing execution hosts', () => {
  beforeEach(() => {
    resetTerminalTabActivityFlagsCacheForTest()
  })

  it('resolves cold cards against their own host when workspace ids collide', () => {
    const multiHostCatalog = buildSessionGridWorktreeCatalog({
      repos: [
        { id: 'local', displayName: 'Local project' } as Repo,
        { id: 'remote', displayName: 'Remote project', connectionId: 'box' } as Repo
      ],
      worktreesByRepo: {
        local: [
          {
            id: 'wt-1',
            displayName: 'Local workspace',
            branch: 'local-branch',
            path: '/local'
          } as Worktree
        ],
        remote: [
          {
            id: 'wt-1',
            displayName: 'Remote workspace',
            branch: 'remote-branch',
            path: '/remote'
          } as Worktree
        ]
      },
      sshTargetLabels: new Map([['box', 'build box']])
    })
    const state = makeState({
      ptyIdsByTabId: {},
      unifiedTabsByWorktree: {
        'wt-1': (['local', 'ssh:box'] as const).map((executionHostId, index) => ({
          id: `tab-${index === 0 ? 'a' : 'b'}`,
          entityId: `tab-${index === 0 ? 'a' : 'b'}`,
          contentType: 'terminal',
          executionHostId,
          worktreeId: 'wt-1',
          groupId: 'group',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: index,
          createdAt: index
        }))
      }
    })
    const listing = buildSessionGridListing(state, multiHostCatalog)
    expect(listing.allItems).toMatchObject([
      {
        executionHostId: 'local',
        repoName: 'Local project',
        worktreeName: 'Local workspace',
        branch: 'local-branch',
        cwd: '/local'
      },
      {
        executionHostId: 'ssh:box',
        repoName: 'Remote project',
        worktreeName: 'Remote workspace',
        branch: 'remote-branch',
        cwd: '/remote',
        hostLabel: 'build box'
      }
    ])
  })

  it('stamps every card with the host its workspace runs on', () => {
    const remoteCatalog = buildSessionGridWorktreeCatalog({
      repos: [{ id: 'repo-1', displayName: 'orca', connectionId: 'box' } as unknown as Repo],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'orca', branch: 'main' } as unknown as Worktree]
      },
      sshTargetLabels: new Map([['box', 'build box']])
    })

    const listing = buildSessionGridListing(makeState(), remoteCatalog)

    expect(listing.allItems.map((item) => item.hostKind)).toEqual(['ssh', 'ssh'])
    expect(listing.allItems[0]).toMatchObject({
      executionHostId: 'ssh:box',
      hostLabel: 'build box'
    })
  })

  it('believes the pty over a workspace that never got a host stamp', () => {
    // The failure this closes: an SSH pty in a workspace whose repo declares no
    // connection. Workspace-only resolution calls that card local — the one answer
    // the badge exists to prevent (docs/reference/ssh-execution-boundary.md).
    const sshPty = 'ssh:box@@pty-7'
    const listing = buildSessionGridListing(
      makeState({
        tabsByWorktree: { 'wt-1': [tab('tab-a', sshPty, 1)] },
        terminalLayoutsByTabId: {
          'tab-a': { activeLeafId: LEAF_A, ptyIdsByLeafId: { [LEAF_A]: sshPty } }
        } as never,
        ptyIdsByTabId: { 'tab-a': [sshPty] }
      }),
      buildSessionGridWorktreeCatalog({
        repos: [{ id: 'repo-1', displayName: 'orca' } as unknown as Repo],
        worktreesByRepo: {
          'repo-1': [{ id: 'wt-1', displayName: 'orca' } as unknown as Worktree]
        },
        sshTargetLabels: new Map([['box', 'build box']])
      }),
      undefined
    )

    expect(listing.allItems[0]).toMatchObject({
      hostKind: 'ssh',
      executionHostId: 'ssh:box',
      hostLabel: 'build box'
    })
  })

  it('reads a paired runtime pty as remote, and names its environment', () => {
    const remotePty = 'remote:env-1@@handle-2'
    const listing = buildSessionGridListing(
      makeState({
        tabsByWorktree: { 'wt-1': [tab('tab-a', remotePty, 1)] },
        terminalLayoutsByTabId: {
          'tab-a': { activeLeafId: LEAF_A, ptyIdsByLeafId: { [LEAF_A]: remotePty } }
        } as never,
        ptyIdsByTabId: { 'tab-a': [remotePty] }
      }),
      buildSessionGridWorktreeCatalog({
        repos: [{ id: 'repo-1', displayName: 'orca' } as unknown as Repo],
        worktreesByRepo: {
          'repo-1': [{ id: 'wt-1', displayName: 'orca' } as unknown as Worktree]
        },
        runtimeEnvironments: [{ id: 'env-1', name: 'studio' }]
      }),
      undefined
    )

    expect(listing.allItems[0]).toMatchObject({
      hostKind: 'remote',
      executionHostId: 'runtime:env-1',
      hostLabel: 'studio'
    })
  })

  it('keeps the workspace host for a card whose pty names none', () => {
    // A parked or still-spawning card must not lose the badge its workspace earned.
    const remoteCatalog = buildSessionGridWorktreeCatalog({
      repos: [{ id: 'repo-1', displayName: 'orca', connectionId: 'box' } as unknown as Repo],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'orca' } as unknown as Worktree]
      },
      sshTargetLabels: new Map([['box', 'build box']])
    })
    const listing = buildSessionGridListing(
      makeState({
        tabsByWorktree: { 'wt-1': [tab('tab-a', 'pty-a', 1)] },
        ptyIdsByTabId: {}
      }),
      remoteCatalog
    )

    expect(listing.allItems[0]?.ptyId).toBeNull()
    expect(listing.allItems[0]).toMatchObject({
      hostKind: 'ssh',
      executionHostId: 'ssh:box',
      hostLabel: 'build box'
    })
  })

  it('does not claim a host for a workspace the catalogs no longer know', () => {
    const listing = buildSessionGridListing(
      makeState({ tabsByWorktree: { 'wt-gone': [tab('tab-z', 'pty-z', 1)] } }),
      catalog
    )

    // No entry means no evidence: `local` with no label, never a guessed remote.
    expect(listing.allItems[0]).toMatchObject({ hostKind: 'local', executionHostId: 'local' })
    expect(listing.allItems[0]?.hostLabel).toBeUndefined()
  })
})
