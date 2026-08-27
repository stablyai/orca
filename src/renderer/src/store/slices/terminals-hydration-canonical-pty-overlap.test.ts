// Keep this bare import first: its vi.mock calls run at module eval, and vitest only hoists vi.mock
// inside the test file itself — reordering it below the store imports breaks hydration here.
import './terminal-hydration-store-test-bootstrap'
import { describe, expect, it } from 'vitest'
import { hydrateWorkspaceTerminalRows } from './terminal-session-row-hydration'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/wt-1'

function makeCanonicalUnifiedTab(entityId: string, sortOrder: number): Tab {
  return {
    id: `unified-${entityId}`,
    entityId,
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: 'Grok',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  }
}

function makeSession(args: {
  tabs: TerminalTab[]
  layouts: WorkspaceSessionState['terminalLayoutsByTabId']
  remoteSessionIdsByTabId?: Record<string, string>
  canonicalEntityIds: string[]
}): WorkspaceSessionState {
  const unifiedTabs = args.canonicalEntityIds.map((entityId, index) =>
    makeCanonicalUnifiedTab(entityId, index)
  )
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE_ID,
    activeWorktreeIdsOnShutdown: [WORKTREE_ID],
    tabsByWorktree: { [WORKTREE_ID]: args.tabs },
    terminalLayoutsByTabId: args.layouts,
    remoteSessionIdsByTabId: args.remoteSessionIdsByTabId,
    unifiedTabs: { [WORKTREE_ID]: unifiedTabs },
    tabGroups: {
      [WORKTREE_ID]: [
        {
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: unifiedTabs[0]?.id ?? null,
          tabOrder: unifiedTabs.map((tab) => tab.id)
        }
      ]
    }
  }
}

function makeSleepingRecord(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: '',
    state: 'waiting',
    capturedAt: 1,
    updatedAt: 1
  }
}

function hydrate(session: WorkspaceSessionState): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
    }
  })
  store.getState().hydrateWorkspaceSession(session)
  store.getState().hydrateTabsSession(session)
  return store
}

describe('hydrateWorkspaceSession canonical PTY overlap', () => {
  it('keeps the valid local row when an invalid-id canonical mirror shares its PTY', () => {
    const sharedPtyId = 'daemon-session-1'
    const mirrorTabId = 'host-tab::11111111-1111-4111-8111-111111111111'
    const session = makeSession({
      tabs: [
        makeTab({ id: mirrorTabId, worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
        makeTab({ id: 'local-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId, sortOrder: 1 })
      ],
      layouts: {
        [mirrorTabId]: { ...makeLayout(), ptyIdsByLeafId: { 'mirror-leaf': sharedPtyId } },
        'local-tab': { ...makeLayout(), ptyIdsByLeafId: { 'local-leaf': sharedPtyId } }
      },
      canonicalEntityIds: [mirrorTabId]
    })

    const state = hydrate(session).getState()
    const persisted = buildWorkspaceSessionPayload(state)

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['local-tab'])
    expect(state.pendingReconnectPtyIdByTabId['local-tab']).toBe(sharedPtyId)
    expect(persisted.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['local-tab'])
    expect(persisted.terminalLayoutsByTabId[mirrorTabId]).toBeUndefined()
  })

  it('keeps a legacy split tab whose second pane owns an independent PTY', () => {
    const sharedPtyId = 'daemon-shared'
    const soloPtyId = 'daemon-solo'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
        makeTab({ id: 'split-tab', worktreeId: WORKTREE_ID, ptyId: soloPtyId, sortOrder: 1 })
      ],
      layouts: {
        'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
        'split-tab': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': sharedPtyId, 'leaf-b': soloPtyId }
        }
      },
      canonicalEntityIds: ['canonical-tab']
    })

    const state = hydrate(session).getState()
    const persisted = buildWorkspaceSessionPayload(state)

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'split-tab'
    ])
    expect(state.pendingReconnectPtyIdByTabId['split-tab']).toBe(soloPtyId)
    // Why: the split row keeps its own PTY and gives up the one the canonical row owns.
    expect(Object.values(state.terminalLayoutsByTabId['split-tab']?.ptyIdsByLeafId ?? {})).toEqual([
      soloPtyId
    ])
    expect(persisted.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'split-tab'
    ])
    expect(
      Object.values(persisted.terminalLayoutsByTabId['split-tab']?.ptyIdsByLeafId ?? {})
    ).toEqual([soloPtyId])
  })

  it('ignores a canonical row’s stale leaf binding when scoring another row’s live PTY', () => {
    const canonicalPtyId = 'daemon-canonical'
    const livePtyId = 'daemon-live'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: canonicalPtyId }),
        makeTab({ id: 'live-tab', worktreeId: WORKTREE_ID, ptyId: livePtyId, sortOrder: 1 })
      ],
      layouts: {
        // 'ghost-leaf' left the tree but its binding was never pruned, so it must not claim livePtyId.
        'canonical-tab': {
          root: { type: 'leaf', leafId: 'canonical-leaf' },
          activeLeafId: 'canonical-leaf',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'canonical-leaf': canonicalPtyId, 'ghost-leaf': livePtyId }
        },
        'live-tab': { ...makeLayout(), ptyIdsByLeafId: { 'live-leaf': livePtyId } }
      },
      canonicalEntityIds: ['canonical-tab']
    })

    const state = hydrate(session).getState()

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'live-tab'
    ])
    expect(state.pendingReconnectPtyIdByTabId['live-tab']).toBe(livePtyId)
  })

  it('strips a retained row’s stale binding to a PTY the canonical row owns', () => {
    const sharedPtyId = 'daemon-shared'
    const soloPtyId = 'daemon-solo'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
        makeTab({ id: 'legacy-tab', worktreeId: WORKTREE_ID, ptyId: soloPtyId, sortOrder: 1 })
      ],
      layouts: {
        'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
        'legacy-tab': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': soloPtyId, 'ghost-leaf': sharedPtyId }
        }
      },
      canonicalEntityIds: ['canonical-tab']
    })

    const state = hydrate(session).getState()

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'legacy-tab'
    ])
    // Why: reconnect publishes every recorded leaf PTY, so a leftover binding would re-duplicate ownership.
    expect(Object.values(state.terminalLayoutsByTabId['legacy-tab']?.ptyIdsByLeafId ?? {})).toEqual(
      [soloPtyId]
    )
  })

  it('ignores a rootless canonical row’s extra bindings when scoring another row’s live PTY', () => {
    const canonicalPtyId = 'daemon-canonical'
    const livePtyId = 'daemon-live'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: canonicalPtyId }),
        makeTab({ id: 'live-tab', worktreeId: WORKTREE_ID, ptyId: livePtyId, sortOrder: 1 })
      ],
      layouts: {
        // Rootless proves ownership only for a sole off-tree pane; a second never-pruned binding proves nothing.
        'canonical-tab': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'canonical-leaf': canonicalPtyId, 'ghost-leaf': livePtyId }
        },
        'live-tab': { ...makeLayout(), ptyIdsByLeafId: { 'live-leaf': livePtyId } }
      },
      canonicalEntityIds: ['canonical-tab']
    })

    const state = hydrate(session).getState()

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'live-tab'
    ])
    expect(state.pendingReconnectPtyIdByTabId['live-tab']).toBe(livePtyId)
  })

  it('advertises a retained row’s own PTY after its tab-level id went to the canonical row', async () => {
    const sharedPtyId = 'daemon-shared'
    const soloPtyId = 'daemon-solo'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
        // tab.ptyId is the shared one, so reconnect skips it; soloPtyId lives only in a leaf binding.
        makeTab({ id: 'split-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId, sortOrder: 1 })
      ],
      layouts: {
        'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
        'split-tab': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': sharedPtyId, 'leaf-b': soloPtyId }
        }
      },
      canonicalEntityIds: ['canonical-tab']
    })

    const store = hydrate(session)
    // Why: the row's own pane lives only in a leaf binding, which orphan detection ignores — without
    // this anchor the sweep below hard-deletes the row and its session never reattaches.
    expect(store.getState().pendingReconnectPtyIdByTabId['split-tab']).toBe(soloPtyId)
    expect(getOrphanTerminalIds(store.getState(), WORKTREE_ID).has('split-tab')).toBe(false)

    store.getState().reconcileWorktreeTabModel(WORKTREE_ID)
    await store.getState().reconnectPersistedTerminals()

    const state = store.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'split-tab'
    ])
    // Why: liveness reads ptyIdsByTabId; without this the surviving pane's PTY reads as an orphan until mount.
    expect(state.ptyIdsByTabId['split-tab']).toEqual([soloPtyId])
  })

  it('drops a sleeping agent record on the leaf whose PTY moved to the canonical row', () => {
    const sharedPtyId = 'daemon-shared'
    const soloPtyId = 'daemon-solo'
    const sharedLeafId = '11111111-1111-4111-8111-111111111111'
    const soloLeafId = '22222222-2222-4222-8222-222222222222'
    const session = {
      ...makeSession({
        tabs: [
          makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
          makeTab({ id: 'split-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId, sortOrder: 1 })
        ],
        layouts: {
          'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
          'split-tab': {
            root: {
              type: 'split' as const,
              direction: 'vertical' as const,
              first: { type: 'leaf' as const, leafId: sharedLeafId },
              second: { type: 'leaf' as const, leafId: soloLeafId }
            },
            activeLeafId: sharedLeafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [sharedLeafId]: sharedPtyId, [soloLeafId]: soloPtyId }
          }
        },
        canonicalEntityIds: ['canonical-tab']
      }),
      sleepingAgentSessionsByPaneKey: {
        [`split-tab:${sharedLeafId}`]: makeSleepingRecord(`split-tab:${sharedLeafId}`, 'split-tab'),
        [`split-tab:${soloLeafId}`]: makeSleepingRecord(`split-tab:${soloLeafId}`, 'split-tab')
      }
    }

    const state = hydrate(session).getState()

    expect(Object.keys(state.sleepingAgentSessionsByPaneKey)).toEqual([`split-tab:${soloLeafId}`])
  })

  it('lets remote-snapshot rows keep every PTY, since unifiedTabs describes the local client', () => {
    const sharedPtyId = 'daemon-shared'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
        makeTab({ id: 'remote-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId, sortOrder: 1 })
      ],
      layouts: {
        'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
        'remote-tab': { ...makeLayout(), ptyIdsByLeafId: { 'remote-leaf': sharedPtyId } }
      },
      canonicalEntityIds: ['canonical-tab']
    })
    const rows = session.tabsByWorktree[WORKTREE_ID]!

    expect(
      hydrateWorkspaceTerminalRows(session, WORKTREE_ID, rows, { rowsFromRemoteSnapshot: true })
        .subsumedTabIds
    ).toEqual([])
    // Guards the gate: without the flag the same rows collapse, so a caller that forgets it drops live remote rows.
    expect(hydrateWorkspaceTerminalRows(session, WORKTREE_ID, rows).subsumedTabIds).toEqual([
      'remote-tab'
    ])
  })

  it('retains a non-canonical row that owns no PTY at all', () => {
    const sharedPtyId = 'daemon-shared'
    const session = makeSession({
      tabs: [
        makeTab({ id: 'canonical-tab', worktreeId: WORKTREE_ID, ptyId: sharedPtyId }),
        makeTab({ id: 'empty-tab', worktreeId: WORKTREE_ID, ptyId: null, sortOrder: 1 })
      ],
      layouts: {
        'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
        'empty-tab': makeLayout()
      },
      canonicalEntityIds: ['canonical-tab']
    })

    const state = hydrate(session).getState()

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'empty-tab'
    ])
  })
})
