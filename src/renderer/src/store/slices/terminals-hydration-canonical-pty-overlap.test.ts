// Keep this bare import first: it installs the preload-API stub the store imports read at eval time.
import './terminal-hydration-store-test-bootstrap'
import { describe, expect, it, vi } from 'vitest'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'

import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import '@/lib/workspace-session'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

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
    // Anchor the retained leaf-only PTY or orphan sweep deletes the row before its pane can reattach.
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
})
