/**
 * Reconnecting an SSH workspace must not delete local state the host has not been told about.
 *
 * Reported from a 60-second manual test: reconnect, and a second tab that was running `pnpm install`
 * is gone while the app drops to the home screen. Both come from the same place — the host snapshot
 * is applied as the whole truth for the reconnecting target, so a tab created locally but not yet
 * uploaded has no branch that keeps it, and a snapshot that names no active worktree nulls the one
 * the user is standing in.
 *
 * This drives the real apply path rather than the merge function alone, and it is deterministic: the
 * end-to-end version of the same scenario only reproduces about one run in three, because the bug
 * needs the tab to be created inside the debounced upload's suppression window.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const TARGET_ID = 'ssh-target-1'
const PATH = '/srv/proj/bug-cats'
const WORKTREE_ID = `repoA::${PATH}`
const OTHER_PATH = '/srv/proj/dogs'
const OTHER_WORKTREE_ID = `repoB::${OTHER_PATH}`
/** The other client of this host, as workspace.changed names it. */
const PEER = 'peer-client-1'

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

function token(snapshotRevision: number): DirectSshSnapshotApplyToken {
  return {
    authority,
    catalogRevision: 0,
    repoFingerprint: 'fp',
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'complete'
  }
}

function ptyIdOf(tabId: string): string {
  return toAppSshPtyId(TARGET_ID, `relay-${tabId}`)
}

function remoteTabs(worktreePath: string, tabIds: readonly string[]) {
  return tabIds.map((tabId, index) => ({
    id: tabId,
    worktreePath,
    ptyId: ptyIdOf(tabId),
    title: `Terminal ${index + 1}`,
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: index + 1
  }))
}

function snapshot(
  revision: number,
  tabIds: readonly string[],
  options: { activeWorktreePath?: string | null; otherTabIds?: readonly string[] } = {}
): RemoteWorkspaceSnapshot {
  const activeWorktreePath =
    options.activeWorktreePath === undefined ? PATH : options.activeWorktreePath
  const allTabIds = [...tabIds, ...(options.otherTabIds ?? [])]
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath,
      activeTabId: tabIds[0] ?? null,
      tabsByWorktreePath: {
        [PATH]: remoteTabs(PATH, tabIds),
        // Why omitted rather than empty when undefined: a peer that does not hold repoB strips the
        // key entirely, which is the case the path guard has to tell apart from a close.
        ...(options.otherTabIds
          ? { [OTHER_PATH]: remoteTabs(OTHER_PATH, options.otherTabIds) }
          : {})
      },
      terminalLayoutsByTabId: {},
      // Why production-shaped: a real host lists the worktrees that were open at shutdown and real
      // ssh:<target>@@<relay-id> session ids, which is what makes hydration seed the reconnect
      // ledgers for every listed tab. A fixture with those empty hides whether the veto is inert.
      activeWorktreePathsOnShutdown: [PATH, ...(options.otherTabIds ? [OTHER_PATH] : [])],
      activeTabIdByWorktreePath: { [PATH]: tabIds[0] ?? null },
      remoteSessionIdsByTabId: Object.fromEntries(allTabIds.map((id) => [id, ptyIdOf(id)])),
      lastVisitedAtByWorktreePath: { [PATH]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [PATH]: true }
    }
  } satisfies RemoteWorkspaceSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

/** `publisherClientId` is what useIpcEvents forwards from workspace.changed's sourceClientId. */
async function applySnapshot(
  store: TestStore,
  snap: RemoteWorkspaceSnapshot,
  publisherClientId?: string | null
): Promise<void> {
  await applyDirectSshRemoteWorkspaceSnapshot({
    store,
    snapshot: snap,
    token: token(snap.revision),
    arrival: 1,
    isArrivalCurrent: () => true,
    isPreparationTokenCurrent: () => true,
    waitForWorkspaceSessionReady: async () => true,
    // Why the real action: useIpcEvents wires this callback to retryDirectSshTargetPanes
    // (useIpcEvents.ts:731-733 -> direct-ssh-reconnect-coordinator.ts:270), and the apply runs it at
    // the end of every snapshot, so in production the reconnect ledgers are populated for every tab
    // of the target before the next snapshot arrives. A stub here hides that entirely.
    finalizeHydratedTerminals: (auth) => store.getState().retryDirectSshTargetPanes(auth),
    publisherClientId
  })
}

function seedCatalog(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repoA',
          path: PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ],
      repoB: [
        makeWorktree({
          id: OTHER_WORKTREE_ID,
          repoId: 'repoB',
          path: OTHER_PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    },
    repos: [
      {
        id: 'repoA',
        path: '/srv/proj',
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      } as never,
      {
        id: 'repoB',
        path: '/srv/proj-dogs',
        displayName: 'Dogs',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      } as never
    ],
    // Why connected: retryDirectSshTargetPanes is a no-op under a non-current authority, and the
    // production apply always runs it under the connected one.
    sshConnectionStates: new Map([
      [
        TARGET_ID,
        {
          status: 'connected',
          providerEpoch: authority.providerEpoch,
          connectionGeneration: authority.connectionGeneration
        } as never
      ]
    ]),
    reconnectPersistedTerminals: (async () => {}) as never,
    // Why: worktree activation revalidates PR state, which reaches window.api in this bare store.
    refreshGitHubForWorktreeIfStale: (() => {}) as never,
    // Why: spawning a pane bumps worktree activity, which reaches window.api in this bare store.
    bumpWorktreeActivity: (() => {}) as never,
    markRemoteWorkspaceHydrated: (() => {}) as never,
    setRemoteWorkspaceSyncStatus: (() => {}) as never
  })
}

function tabIdsOf(store: TestStore): string[] {
  return (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
}

function otherTabIdsOf(store: TestStore): string[] {
  return (store.getState().tabsByWorktree[OTHER_WORKTREE_ID] ?? []).map((tab) => tab.id)
}

/**
 * The ordinary create-a-tab-while-connected flow: the user opens a tab and its pane spawns a remote
 * pty. Both are real store actions — nothing seeds the direct-SSH reconnect ledgers, because on this
 * path nothing ever does.
 */
function spawnLocalTab(store: TestStore, tabId: string): TerminalTab {
  const tab = store.getState().createTab(WORKTREE_ID, undefined, undefined, { id: tabId })
  store.getState().updateTabPtyId(tab.id, ptyIdOf(tab.id))
  return tab
}

/** A tab the user created locally whose upload has not landed yet. */
function addLocalTab(store: TestStore, tabId: string): void {
  const live = store.getState()
  store.setState({
    tabsByWorktree: {
      ...live.tabsByWorktree,
      [WORKTREE_ID]: [
        ...(live.tabsByWorktree[WORKTREE_ID] ?? []),
        {
          id: tabId,
          worktreeId: WORKTREE_ID,
          type: 'terminal',
          title: tabId
        } as never
      ]
    }
  })
}

describe('direct-SSH snapshot apply keeps local state the host has not seen', () => {
  it('keeps a tab created locally between snapshots', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)

    // The reported `setup` tab: created after the first snapshot, upload still pending, so the next
    // snapshot the host sends still knows only about `agent`.
    addLocalTab(store, 'setup')
    await applySnapshot(store, snapshot(2, ['agent']))

    const tabIds = (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
    expect(tabIds, 'the reconnect deleted a tab the host had never been told about').toContain(
      'setup'
    )
    expect(tabIds).toContain('agent')
  })

  it('leaves the user on their workspace when the snapshot names no active worktree', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)
    expect(store.getState().activeWorktreeId).toBe(WORKTREE_ID)

    // A snapshot whose active path does not resolve to a known worktree. Taking that as "no active
    // workspace" is what drops the user to the home screen mid-session.
    await applySnapshot(store, snapshot(2, ['agent'], { activeWorktreePath: null }))

    expect(
      store.getState().activeWorktreeId,
      'the reconnect dropped the user to the home screen'
    ).toBe(WORKTREE_ID)
  })

  it('still follows the host when the snapshot does name an active worktree', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)

    await applySnapshot(store, snapshot(2, ['agent'], { activeWorktreePath: PATH }))

    expect(store.getState().activeWorktreeId).toBe(WORKTREE_ID)
  })

  it('does not duplicate a tab across repeated snapshots', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await applySnapshot(store, snapshot(1, ['agent']))
    store.getState().setActiveWorktree(WORKTREE_ID)
    addLocalTab(store, 'setup')

    await applySnapshot(store, snapshot(2, ['agent']))
    await applySnapshot(store, snapshot(3, ['agent']))

    const tabIds = (store.getState().tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
    expect(tabIds).toEqual([...new Set(tabIds)])
    expect(tabIds.filter((id) => id === 'setup')).toHaveLength(1)
  })

  it('drops a tab another client closed once that client stops listing it', async () => {
    // The other half of the same ambiguity. The peer listed both tabs, then listed only one: that is
    // a RETRACTION by the client that wrote both listings, not mere absence. Preserving it forever
    // also re-uploads it, and because patches are replace-session the tab comes back on the host and
    // on the client that closed it.
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent', 'closed-elsewhere']), PEER)
    expect(tabIdsOf(store)).toEqual(['agent', 'closed-elsewhere'])
    // The state production is actually in when the retraction arrives: the apply's retry pass has
    // given the tab a pending retry and bumped its generation past anything the peer listed. Both
    // are per-client pty bookkeeping, so neither may veto the peer's retraction.
    expect(store.getState().directSshPaneRetryByTabId).toHaveProperty('closed-elsewhere')
    expect(
      store.getState().tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === 'closed-elsewhere')
        ?.generation
    ).toBe(1)

    await applySnapshot(store, snapshot(2, ['agent']), PEER)

    expect(tabIdsOf(store), 'a tab closed on another client survived the next snapshot').toEqual([
      'agent'
    ])
  })

  it('retires the closed tab and keeps the upload-pending one from the same snapshot', async () => {
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent', 'closed-elsewhere']), PEER)
    addLocalTab(store, 'setup')

    await applySnapshot(store, snapshot(2, ['agent']), PEER)

    expect(tabIdsOf(store)).toContain('setup')
    expect(tabIdsOf(store)).not.toContain('closed-elsewhere')
  })

  it('keeps every tab of a worktree a peer with a narrower repo set omits', async () => {
    // The namespace is shared by every client of the host and workspace.patch is replace-session, so
    // a peer that holds repoA but not repoB strips the repoB key on EVERY push. Reading that as
    // "the host retired those tabs" deletes live panes whose ptys this path deliberately never
    // kills, orphaning the remote processes.
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent'], { otherTabIds: ['dogs-build'] }), PEER)
    expect(otherTabIdsOf(store)).toEqual(['dogs-build'])

    await applySnapshot(store, snapshot(2, ['agent']), PEER)

    expect(otherTabIdsOf(store), 'a peer that does not hold repoB retired its tabs').toEqual([
      'dogs-build'
    ])
  })

  it('keeps a tab created here while connected when a stale peer rewrites the namespace', async () => {
    // The reviewer's repro, driven through the real create-a-tab path. The peer's MAIN-process cache
    // already holds the revision carrying `setup` — that is what it CAS'd on — while its renderer
    // apply still lags, so it republishes an older tab list at a newer revision. The tab has a
    // mounted pane and a running remote pty; nothing about the peer's write is evidence about it.
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent']), PEER)

    const setup = spawnLocalTab(store, 'setup')
    // The create path seeds no reconnect ledger for the new tab, while the apply's retry pass has
    // already seeded one for every host-listed tab — which is exactly why a ledger-shaped veto is
    // both useless here and universal there.
    expect(store.getState().directSshPaneRetryByTabId).not.toHaveProperty(setup.id)
    expect(store.getState().directSshLivePtyBindingByTabId).not.toHaveProperty(setup.id)
    expect(store.getState().directSshPaneRetryByTabId).toHaveProperty('agent')
    // The host itself now lists `setup` at rev 2 — the harder case, since even a full host listing
    // is unattributed and so can never be retracted by a peer that never wrote it.
    store.getState().recordRemoteWorkspaceHostAck(TARGET_ID, snapshot(2, ['agent', 'setup']), null)

    await applySnapshot(store, snapshot(3, ['agent']), PEER)

    expect(tabIdsOf(store), 'a live locally created pane was retired').toContain(setup.id)
    expect(
      store.getState().lastKnownRelayPtyIdByTabId[setup.id],
      "the apply dropped this client's claim on a running remote process"
    ).toBe(ptyIdOf(setup.id))
  })

  it('never retires it however often that peer republishes without it', async () => {
    // Not a delay: a publisher that never listed the id has nothing to retract, so repeating the
    // stale write cannot wear the guard down.
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent']), PEER)
    const setup = spawnLocalTab(store, 'setup')

    await applySnapshot(store, snapshot(2, ['agent']), PEER)
    await applySnapshot(store, snapshot(3, ['agent']), PEER)
    await applySnapshot(store, snapshot(4, ['agent']), PEER)

    expect(tabIdsOf(store)).toContain(setup.id)
  })

  it('retires that same tab once the peer has listed it and then drops it', async () => {
    // The guard delays retirement to the point where there IS evidence: the peer applies this
    // client's upload, republishes with `setup` in it, and only its next omission is a retraction.
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent']), PEER)
    const setup = spawnLocalTab(store, 'setup')
    await applySnapshot(store, snapshot(2, ['agent', 'setup']), PEER)
    expect(tabIdsOf(store)).toContain(setup.id)

    await applySnapshot(store, snapshot(3, ['agent']), PEER)

    expect(tabIdsOf(store)).toEqual(['agent'])
  })

  it('ignores an unattributed snapshot, which is what a workspace.get pull is', async () => {
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent', 'closed-elsewhere']), PEER)

    await applySnapshot(store, snapshot(2, ['agent']))

    expect(tabIdsOf(store)).toContain('closed-elsewhere')
  })

  it('keeps the retired tab out of the next uploaded payload', async () => {
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent', 'closed-elsewhere']), PEER)

    await applySnapshot(store, snapshot(2, ['agent']), PEER)

    // Guards the resurrection loop: whatever survives here is what the next persist pushes back.
    const payload = buildWorkspaceSessionPayload(store.getState())
    expect(payload.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).not.toContain(
      'closed-elsewhere'
    )
    expect(Object.keys(payload.remoteSessionIdsByTabId ?? {})).not.toContain('closed-elsewhere')
  })
})

/**
 * Retirement removes the tab from the session model, which is only half of what a close owes it.
 * The renderer keeps per-tab maps outside that model — agentStatusByPaneKey above all — and the
 * sidebar's live index buckets a non-'done' entry whose tab id it cannot find under the entry's own
 * worktree, so a survivor renders as a live agent row for a tab that no longer exists, and clicking
 * it cannot clear it (WorktreeCardAgents bails when the row already sits on its own worktree).
 *
 * A BACKGROUND pane is the case that has no other cleanup: its status is written straight from the
 * hook stream whether or not the pane is mounted, so no pty-exit or unmount handler ever clears it.
 */
describe('a peer-retired tab leaves no renderer state behind', () => {
  const PANE_KEY = 'closed-elsewhere:leaf-1'

  async function seedRetiredTabWithLiveAgent(store: TestStore): Promise<void> {
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent', 'closed-elsewhere']), PEER)
    store
      .getState()
      .setAgentStatus(PANE_KEY, { state: 'working', prompt: 'pnpm install', agentType: 'claude' })
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe('working')
  }

  it('drops the agent status of the tab the peer closed', async () => {
    const store = createTestStore()
    await seedRetiredTabWithLiveAgent(store)

    await applySnapshot(store, snapshot(2, ['agent']), PEER)

    expect(tabIdsOf(store)).toEqual(['agent'])
    expect(
      Object.keys(store.getState().agentStatusByPaneKey).filter((key) =>
        key.startsWith('closed-elsewhere:')
      ),
      'a live agent row outlived the tab a peer closed, and the sidebar has no way to clear it'
    ).toEqual([])
  })

  it('keeps the agent status of a pinned tab, which retirement refuses to close', async () => {
    // The pin is the local user's explicit "do not take this away from me", so the primitive refuses
    // the close and the tab stays on screen — sweeping its state would blank a live agent row.
    const store = createTestStore()
    seedCatalog(store)
    store.getState().setActiveWorktree(WORKTREE_ID)
    await applySnapshot(store, snapshot(1, ['agent']), PEER)
    // Why created here rather than taken from the snapshot: pinning is a unified-tab gesture, and the
    // create path is what mints the unified row (a host listing projects terminal rows only).
    const setup = spawnLocalTab(store, 'setup')
    store.getState().setAgentStatus(`${setup.id}:leaf-1`, {
      state: 'working',
      prompt: 'pnpm install',
      agentType: 'claude'
    })
    store.getState().pinTab(setup.id)
    // The peer listing it is what makes its next omission a retraction, so retirement is decided and
    // only the pin stops it.
    await applySnapshot(store, snapshot(2, ['agent', 'setup']), PEER)

    await applySnapshot(store, snapshot(3, ['agent']), PEER)

    expect(tabIdsOf(store)).toContain('setup')
    expect(
      store.getState().agentStatusByPaneKey[`${setup.id}:leaf-1`]?.state,
      'a pinned tab that was never retired lost its agent status'
    ).toBe('working')
  })
})
