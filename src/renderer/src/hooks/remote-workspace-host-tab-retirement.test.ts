/**
 * Where the merge's "preserve anything the host does not list" trade is finally resolved.
 *
 * mergeDirectSshRemoteWorkspaceSession has one bit of evidence per tab — is it in THIS snapshot? —
 * and has to answer two questions with it: has the host ever been told about this tab, and does it
 * still hold it? It preserves, which keeps a locally created tab alive but also keeps a tab another
 * client closed (and re-uploads it, since patches are replace-session, resurrecting it host-side).
 *
 * Absence itself can never separate the two: the namespace is SHARED, every client rewrites the
 * whole file from whatever its renderer last knew, and the relay pins baseRevision to revision - 1,
 * so "closed" and "the writer never knew" are byte-identical snapshots.
 *
 * The disambiguator is therefore RETRACTION, not absence: `workspace.changed` names the client that
 * wrote the listing, and a tab may only be removed when the SAME client that once listed it stops
 * listing it. A publisher that never listed the tab — the stale peer, the peer with a narrower repo
 * set, an unattributed pull — can rewrite the namespace forever without retiring anything.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  recordRemoteWorkspaceHostAck,
  selectHostRetiredTabIdsByWorktree,
  type RemoteWorkspaceHostAckLedger
} from './remote-workspace-host-ack-ledger'
import { retireHostClosedTabsFromSession } from './remote-workspace-host-tab-retirement'

const TARGET_ID = 'ssh-target-1'
const PEER = 'peer-client-1'
const NAMESPACE = 'namespace-1'
const PATH = '/srv/proj/bug-cats'
const WORKTREE = `repo-1::${PATH}`
const OTHER_PATH = '/srv/proj/dogs'
const OTHER_WORKTREE = `repo-2::${OTHER_PATH}`

function terminalTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE,
    title: id,
    customTitle: null,
    color: null,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function unifiedTab(entityId: string, groupId = 'group-1'): Tab {
  return {
    id: `unified-${entityId}`,
    entityId,
    groupId,
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned: false
  }
}

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    activeWorkspaceKey: `worktree:${WORKTREE}`,
    activeTabId: 'agent',
    tabsByWorktree: {
      [WORKTREE]: [terminalTab('agent'), terminalTab('closed-elsewhere')]
    },
    terminalLayoutsByTabId: {
      agent: {
        root: { type: 'leaf', leafId: 'leaf-agent' },
        ptyIdsByLeafId: {},
        activeLeafId: 'leaf-agent',
        expandedLeafId: null
      },
      'closed-elsewhere': {
        root: { type: 'leaf', leafId: 'leaf-closed' },
        ptyIdsByLeafId: { 'leaf-closed': 'pty-closed-elsewhere' },
        activeLeafId: 'leaf-closed',
        expandedLeafId: null
      }
    },
    activeTabIdByWorktree: { [WORKTREE]: 'closed-elsewhere' },
    remoteSessionIdsByTabId: {
      agent: 'remote-agent',
      'closed-elsewhere': 'remote-closed'
    },
    unifiedTabs: {
      [WORKTREE]: [unifiedTab('agent'), unifiedTab('closed-elsewhere', 'group-2')]
    },
    tabGroups: {
      [WORKTREE]: [
        {
          id: 'group-1',
          worktreeId: WORKTREE,
          tabOrder: ['unified-agent'],
          activeTabId: 'unified-agent'
        },
        {
          id: 'group-2',
          worktreeId: WORKTREE,
          tabOrder: ['unified-closed-elsewhere'],
          activeTabId: 'unified-closed-elsewhere'
        }
      ]
    },
    tabGroupLayouts: {
      [WORKTREE]: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' },
        ratio: 0.5
      }
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'group-2' },
    ...overrides
  }
}

function snapshot(
  revision: number,
  tabsByPath: Record<string, { id: string; generation?: number }[]>,
  options: { namespace?: string } = {}
): RemoteWorkspaceSnapshot {
  return {
    namespace: options.namespace ?? NAMESPACE,
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: PATH,
      activeTabId: null,
      tabsByWorktreePath: Object.fromEntries(
        Object.entries(tabsByPath).map(([worktreePath, tabs]) => [
          worktreePath,
          tabs.map((tab) => ({
            id: tab.id,
            worktreePath,
            ptyId: `pty-${tab.id}`,
            title: tab.id,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ...(tab.generation === undefined ? {} : { generation: tab.generation })
          }))
        ])
      ),
      terminalLayoutsByTabId: {}
    }
  }
}

type ObserveOptions = {
  targetId?: string
  publisherId?: string | null
}

/** What the ssh slice does on every host listing: fold it in under its publisher, bounded by the tabs still held here. */
function observe(
  ledger: RemoteWorkspaceHostAckLedger,
  next: RemoteWorkspaceSnapshot,
  current: WorkspaceSessionState,
  options: ObserveOptions = {}
): RemoteWorkspaceHostAckLedger {
  return recordRemoteWorkspaceHostAck(
    ledger,
    options.targetId ?? TARGET_ID,
    next,
    current.tabsByWorktree,
    options.publisherId === undefined ? PEER : options.publisherId
  )
}

type RetireOptions = {
  worktreeIds?: ReadonlySet<string>
  publisherId?: string | null
}

/** The composition the apply path runs: select against pre-merge local state, then subtract. */
function retire(
  current: WorkspaceSessionState,
  ledger: RemoteWorkspaceHostAckLedger,
  next: RemoteWorkspaceSnapshot,
  options: RetireOptions = {}
): { retiredTabIds: string[]; session: WorkspaceSessionState } {
  const worktreeIds = options.worktreeIds ?? new Set([WORKTREE])
  const retiredTabIdsByWorktreeId = selectHostRetiredTabIdsByWorktree({
    ledger,
    targetId: TARGET_ID,
    snapshot: next,
    publisherId: options.publisherId === undefined ? PEER : options.publisherId,
    localTabsByWorktree: current.tabsByWorktree,
    worktreeIds
  })
  return {
    retiredTabIds: [...retiredTabIdsByWorktreeId.values()].flatMap((ids) => [...ids]),
    session: retireHostClosedTabsFromSession(current, retiredTabIdsByWorktreeId)
  }
}

const peerListedBoth = observe(
  {},
  snapshot(5, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere' }] }),
  session()
)

describe('retiring tabs the host positively closed', () => {
  it('removes the whole tab model for a tab the publisher listed at rev 5 and dropped at rev 6', () => {
    const { session: next } = retire(
      session(),
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
    // Why all of these: pruning tabsByWorktree alone leaves an unpaintable row in the tab bar that
    // projectWorktreeTabModelReconciliation then re-adopts.
    expect(next.unifiedTabs?.[WORKTREE]?.map((tab) => tab.entityId)).toEqual(['agent'])
    expect(next.tabGroups?.[WORKTREE]?.map((group) => group.id)).toEqual(['group-1'])
    expect(next.tabGroupLayouts?.[WORKTREE]).toEqual({
      type: 'leaf',
      groupId: 'group-1'
    })
    expect(next.terminalLayoutsByTabId['closed-elsewhere']).toBeUndefined()
    expect(next.remoteSessionIdsByTabId?.['closed-elsewhere']).toBeUndefined()
  })

  it('keeps a tab the publisher never listed, even in the same snapshot', () => {
    // The upload-pending tab: `setup` was created locally after the rev-5 listing, so no peer has
    // ever listed it and its absence at rev 6 means "never uploaded", not "retired".
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent'), terminalTab('setup')]
      }
    })

    const { session: next } = retire(
      current,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent', 'setup'])
  })

  it('keeps the tab when the snapshot is older than the publisher watermark', () => {
    // Snapshot applies are not revision-fenced, so an out-of-order arrival is normal and its
    // omissions prove nothing.
    const { session: next } = retire(
      session(),
      peerListedBoth,
      snapshot(4, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('keeps the tab after a relay reset moves the revision line backwards', () => {
    const acked = observe(
      {},
      snapshot(9, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere' }] }),
      session()
    )

    const { session: next } = retire(session(), acked, snapshot(1, { [PATH]: [{ id: 'agent' }] }))

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('retires it even though a local pane retry bumped the generation past the listed one', () => {
    // generation is a per-CLIENT counter: retryDirectSshTerminalPanes bumps it on every reconnect
    // without the peer ever seeing it, so `local > listed` is not a comparison of like quantities and
    // is true for essentially every tab after the retry pass. Tab identity is carried by the id
    // alone, which createTab mints fresh rather than reuse, so the retraction is about this tab.
    const respawned = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent'), terminalTab('closed-elsewhere', { generation: 4 })]
      }
    })
    const listedAtGeneration2 = observe(
      {},
      snapshot(5, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere', generation: 2 }] }),
      respawned
    )

    const { session: next } = retire(
      respawned,
      listedAtGeneration2,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
  })

  it('still retires a hydrated row, which session hydration always marks pendingActivationSpawn', () => {
    // The flag is stamped on every restored row, so treating it as "created locally, never uploaded"
    // would veto every tab and leave this inert. The retraction is what distinguishes them.
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [
          terminalTab('agent', { pendingActivationSpawn: true }),
          terminalTab('closed-elsewhere', { pendingActivationSpawn: true })
        ]
      }
    })

    const { session: next } = retire(
      current,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
  })

  it('never lets one target listing authorize a retirement under another', () => {
    const listedForOtherTarget = observe(
      {},
      snapshot(5, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere' }] }),
      session(),
      { targetId: 'ssh-target-2' }
    )

    const { session: next } = retire(
      session(),
      listedForOtherTarget,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('never lets a listing from another namespace authorize a retirement', () => {
    // A repointed target keeps its id but gets a new namespace, so its revision line is unrelated.
    const { session: next } = retire(
      session(),
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }, { namespace: 'namespace-2' })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('leaves worktrees outside the target scope untouched', () => {
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent')],
        [OTHER_WORKTREE]: [terminalTab('closed-elsewhere', { worktreeId: OTHER_WORKTREE })]
      }
    })

    const { retiredTabIds, session: next } = retire(
      current,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(retiredTabIds).toEqual([])
    expect(next.tabsByWorktree[OTHER_WORKTREE].map((tab) => tab.id)).toEqual(['closed-elsewhere'])
  })

  it('retires only the copy under the path the publisher listed the id at', () => {
    // A worktree rename can leave the same id under two keys with different per-copy evidence. Each
    // copy is judged on its own listing, so the copy the publisher never listed under stays and the
    // duplicate-repair pass converges it; retiring it here would delete the wrong pane.
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent'), terminalTab('closed-elsewhere')],
        [OTHER_WORKTREE]: [terminalTab('closed-elsewhere', { worktreeId: OTHER_WORKTREE })]
      }
    })

    const { session: next } = retire(
      current,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }], [OTHER_PATH]: [] }),
      { worktreeIds: new Set([WORKTREE, OTHER_WORKTREE]) }
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
    expect(next.tabsByWorktree[OTHER_WORKTREE].map((tab) => tab.id)).toEqual(['closed-elsewhere'])
  })

  it('keeps the second copy when the snapshot never describes its worktree', () => {
    // The path guard decides retirability, so the grouping pass has to honour it too: a holder the
    // writer never described is one it could not have listed tabs for.
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent'), terminalTab('closed-elsewhere')],
        [OTHER_WORKTREE]: [terminalTab('closed-elsewhere', { worktreeId: OTHER_WORKTREE })]
      }
    })

    const { session: next } = retire(
      current,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      { worktreeIds: new Set([WORKTREE, OTHER_WORKTREE]) }
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
    expect(next.tabsByWorktree[OTHER_WORKTREE].map((tab) => tab.id)).toEqual(['closed-elsewhere'])
  })

  it('leaves a pinned tab in place', () => {
    // A pin is the local user's explicit "do not take this away from me", and retirement is the one
    // close gesture they did not ask for. The trade is that the resurrection loop stays open for
    // pinned tabs, which is exactly today's behaviour rather than a regression.
    const pinned = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent'), terminalTab('closed-elsewhere', { isPinned: true })]
      }
    })

    const { session: next } = retire(
      pinned,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('re-derives the active tab when the retired one was active', () => {
    const { session: next } = retire(
      session(),
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.activeTabIdByWorktree?.[WORKTREE]).toBe('agent')
    expect(next.activeGroupIdByWorktree?.[WORKTREE]).toBe('group-1')
  })

  it('kills nothing: retirement returns a session and no pty list', () => {
    // The closing client already killed the pty; if that failed, the process may have been rebound
    // by another client, so this path must never issue a kill.
    const result = retireHostClosedTabsFromSession(
      session(),
      new Map([[WORKTREE, new Set(['closed-elsewhere'])]])
    )

    expect('ptyIdsToKill' in result).toBe(false)
  })
})

describe('guards against peers that never knew about the tab', () => {
  it('keeps every tab under a worktree the retiring snapshot does not describe', () => {
    // A peer of the same host that holds only repo-1 exports only /srv/proj/bug-cats, and because
    // workspace.patch is replace-session over the shared namespace its push strips the dogs key on
    // EVERY write. Reading that as "the host retired those tabs" deletes live panes whose remote
    // ptys this path deliberately does not kill, orphaning the processes.
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent')],
        [OTHER_WORKTREE]: [
          terminalTab('dogs-build', { worktreeId: OTHER_WORKTREE }),
          terminalTab('dogs-agent', { worktreeId: OTHER_WORKTREE })
        ]
      }
    })
    const listed = observe(
      {},
      snapshot(5, {
        [PATH]: [{ id: 'agent' }],
        [OTHER_PATH]: [{ id: 'dogs-build' }, { id: 'dogs-agent' }]
      }),
      current
    )

    const { retiredTabIds, session: next } = retire(
      current,
      listed,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      { worktreeIds: new Set([WORKTREE, OTHER_WORKTREE]) }
    )

    expect(retiredTabIds).toEqual([])
    expect(next.tabsByWorktree[OTHER_WORKTREE].map((tab) => tab.id)).toEqual([
      'dogs-build',
      'dogs-agent'
    ])
  })

  it('still retires the last tab of a worktree the peer describes as empty', () => {
    // The guard is about the KEY, not the tabs under it: closing the last tab leaves the worktree in
    // tabsByWorktree with an empty array, so the export still carries the path.
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent')],
        [OTHER_WORKTREE]: [terminalTab('dogs-build', { worktreeId: OTHER_WORKTREE })]
      }
    })
    const listed = observe(
      {},
      snapshot(5, { [PATH]: [{ id: 'agent' }], [OTHER_PATH]: [{ id: 'dogs-build' }] }),
      current
    )

    const { session: next } = retire(
      current,
      listed,
      snapshot(6, { [PATH]: [{ id: 'agent' }], [OTHER_PATH]: [] }),
      { worktreeIds: new Set([WORKTREE, OTHER_WORKTREE]) }
    )

    expect(next.tabsByWorktree[OTHER_WORKTREE]).toEqual([])
  })

  it('keeps a standing retraction the target scope could not act on yet', () => {
    // The worktree was not in scope when the peer dropped the id (catalog not resolved yet), so the
    // omission is carried forward and the next one still retires it, rather than being forgotten.
    const current = session()
    const afterMissedScope = observe(
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      current
    )
    const { retiredTabIds: missed } = retire(
      current,
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      { worktreeIds: new Set() }
    )
    expect(missed).toEqual([])

    const { session: next } = retire(
      current,
      afterMissedScope,
      snapshot(7, { [PATH]: [{ id: 'agent' }] })
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toEqual(['agent'])
  })

  it('keeps the tab when a DIFFERENT client publishes the omitting snapshot', () => {
    // The stale-peer case in miniature: another client of the same host CAS'd on a revision its
    // renderer has not applied, so it rewrites the shared namespace from an older tab list. It never
    // listed this id, so its omission is not a retraction.
    const { retiredTabIds, session: next } = retire(
      session(),
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      { publisherId: 'peer-client-2' }
    )

    expect(retiredTabIds).toEqual([])
    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('keeps the tab when the snapshot has no publisher at all', () => {
    // workspace.get pulls, and relays too old to echo sourceClientId: nobody to attribute the
    // omission to, so it degrades to the merge's preserve rule.
    const { session: next } = retire(
      session(),
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      { publisherId: null }
    )

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('records nothing for an unattributed listing, so it cannot seed a later retraction', () => {
    const current = session()
    const pulled = observe(
      {},
      snapshot(5, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere' }] }),
      current,
      { publisherId: null }
    )

    const { session: next } = retire(current, pulled, snapshot(6, { [PATH]: [{ id: 'agent' }] }))

    expect(next.tabsByWorktree[WORKTREE].map((tab) => tab.id)).toContain('closed-elsewhere')
  })

  it('drops the standing candidate when the peer stops describing its worktree', () => {
    const current = session({
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('agent')],
        [OTHER_WORKTREE]: [terminalTab('dogs-build', { worktreeId: OTHER_WORKTREE })]
      }
    })
    const listed = observe(
      {},
      snapshot(5, { [PATH]: [{ id: 'agent' }], [OTHER_PATH]: [{ id: 'dogs-build' }] }),
      current
    )
    const afterNarrowPeer = observe(listed, snapshot(6, { [PATH]: [{ id: 'agent' }] }), current)

    expect(
      afterNarrowPeer[TARGET_ID]?.listingsByPublisherId[PEER]?.tabsById['dogs-build']
    ).toBeUndefined()
  })

  it('keeps the local active worktree selected when a peer closes its last tab', () => {
    // Closing the last surface normally lands the user on the home screen. That is a navigation the
    // local user asked for; a peer's close is not.
    const current = session({
      tabsByWorktree: { [WORKTREE]: [terminalTab('closed-elsewhere')] },
      unifiedTabs: { [WORKTREE]: [unifiedTab('closed-elsewhere', 'group-2')] },
      tabGroups: {
        [WORKTREE]: [
          {
            id: 'group-2',
            worktreeId: WORKTREE,
            tabOrder: ['unified-closed-elsewhere'],
            activeTabId: 'unified-closed-elsewhere'
          }
        ]
      },
      activeWorkspaceExecutionHostId: 'ssh:host-1'
    })

    const { session: next } = retire(current, peerListedBoth, snapshot(6, { [PATH]: [] }))

    expect(next.tabsByWorktree[WORKTREE]).toEqual([])
    expect(next.activeWorktreeId).toBe(WORKTREE)
    expect(next.activeWorkspaceKey).toBe(`worktree:${WORKTREE}`)
    expect(next.activeWorkspaceExecutionHostId).toBe('ssh:host-1')
  })
})

describe('the publisher listing ledger itself', () => {
  it("ignores a listing at or below that publisher's recorded revision", () => {
    // Snapshot applies are not revision-fenced, so a late older listing must not become that
    // publisher's "latest" and discard what it listed in between.
    const current = session()
    const atNine = observe(
      {},
      snapshot(9, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere' }] }),
      current
    )

    const late = observe(atNine, snapshot(7, { [PATH]: [{ id: 'agent' }] }), current)

    expect(late).toBe(atNine)
    expect(late[TARGET_ID]?.listingsByPublisherId[PEER]?.revision).toBe(9)
    expect(
      late[TARGET_ID]?.listingsByPublisherId[PEER]?.tabsById['closed-elsewhere']?.worktreePath
    ).toBe(PATH)
  })

  it("tracks publishers independently, so one peer's revision cannot fence another's", () => {
    const current = session()
    const twoPeers = observe(
      observe({}, snapshot(9, { [PATH]: [{ id: 'agent' }, { id: 'closed-elsewhere' }] }), current),
      snapshot(10, { [PATH]: [{ id: 'agent' }] }),
      current,
      { publisherId: 'peer-client-2' }
    )

    expect(twoPeers[TARGET_ID]?.listingsByPublisherId[PEER]?.revision).toBe(9)
    expect(twoPeers[TARGET_ID]?.listingsByPublisherId['peer-client-2']?.revision).toBe(10)
    // peer-client-2 never listed the id, so its omission retires nothing.
    expect(
      retire(current, twoPeers, snapshot(11, { [PATH]: [{ id: 'agent' }] }), {
        publisherId: 'peer-client-2'
      }).retiredTabIds
    ).toEqual([])
  })

  it('rebuilds from scratch when the namespace changes', () => {
    const current = session()
    const repointed = observe(
      peerListedBoth,
      snapshot(1, { [PATH]: [{ id: 'agent' }] }, { namespace: 'namespace-2' }),
      current
    )

    expect(repointed[TARGET_ID]?.namespace).toBe('namespace-2')
    expect(repointed[TARGET_ID]?.listingsByPublisherId[PEER]?.revision).toBe(1)
    expect(
      repointed[TARGET_ID]?.listingsByPublisherId[PEER]?.tabsById['closed-elsewhere']
    ).toBeUndefined()
  })

  it('reads only the worktrees this target listed', () => {
    // tabsByWorktree spans every repo on every host; an ack for one target must not walk another's.
    let unrelatedReads = 0
    const current = session({
      tabsByWorktree: Object.defineProperties(
        { [WORKTREE]: [terminalTab('agent'), terminalTab('closed-elsewhere')] },
        {
          [OTHER_WORKTREE]: {
            enumerable: true,
            get: () => {
              unrelatedReads += 1
              return []
            }
          }
        }
      ) as WorkspaceSessionState['tabsByWorktree']
    })

    observe(peerListedBoth, snapshot(6, { [PATH]: [{ id: 'agent' }] }), current)

    expect(unrelatedReads).toBe(0)
  })

  it('bounds itself to a fixed number of publishers, keeping the freshest', () => {
    // Publisher ids are minted per process, so a long session facing restarting peers would
    // otherwise accumulate one entry per peer launch.
    const current = session()
    let ledger: RemoteWorkspaceHostAckLedger = {}
    for (let index = 0; index < 12; index += 1) {
      ledger = observe(ledger, snapshot(index + 1, { [PATH]: [{ id: 'agent' }] }), current, {
        publisherId: `peer-${index}`
      })
    }

    const publisherIds = Object.keys(ledger[TARGET_ID]?.listingsByPublisherId ?? {})
    expect(publisherIds).toHaveLength(8)
    expect(publisherIds).toContain('peer-11')
    expect(publisherIds).not.toContain('peer-0')
  })

  it('forgets a standing candidate this client no longer holds', () => {
    // Bounds the ledger: once the tab is gone from local state nothing can retire it.
    const withoutClosed = session({ tabsByWorktree: { [WORKTREE]: [terminalTab('agent')] } })

    const pruned = observe(
      peerListedBoth,
      snapshot(6, { [PATH]: [{ id: 'agent' }] }),
      withoutClosed
    )

    expect(Object.keys(pruned[TARGET_ID]?.listingsByPublisherId[PEER]?.tabsById ?? {})).toEqual([
      'agent'
    ])
  })
})
