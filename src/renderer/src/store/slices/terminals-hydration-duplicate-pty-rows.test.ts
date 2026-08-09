import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const apiProxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'then' ? undefined : apiProxy()),
    apply: () => Promise.resolve(null)
  })

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: apiProxy() }

const WORKTREE_ID = 'repo1::/wt-1'

function seedWorktree(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
    }
  })
}

function baseSession(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE_ID,
    activeWorktreeIdsOnShutdown: [WORKTREE_ID],
    ...overrides
  }
}

function unifiedTerminalTab(entityId: string, label: string, sortOrder: number) {
  return {
    id: `${entityId}-unified`,
    entityId,
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'terminal' as const,
    label,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

describe('hydrateWorkspaceSession duplicate PTY rows', () => {
  it('gives the canonical Grok row sole ownership of a PTY a stale row also claims', () => {
    const store = createTestStore()
    seedWorktree(store)
    const grokPtyId = 'daemon-session-grok'

    store.getState().hydrateWorkspaceSession(
      baseSession({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            makeTab({
              id: 'stale-tab',
              worktreeId: WORKTREE_ID,
              ptyId: grokPtyId,
              sortOrder: 0
            }),
            makeTab({
              id: 'grok-tab',
              worktreeId: WORKTREE_ID,
              ptyId: grokPtyId,
              sortOrder: 1
            })
          ]
        },
        terminalLayoutsByTabId: {
          'stale-tab': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:stale': grokPtyId }
          },
          'grok-tab': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:grok': grokPtyId }
          }
        },
        unifiedTabs: {
          [WORKTREE_ID]: [unifiedTerminalTab('grok-tab', 'Grok', 0)]
        }
      })
    )

    const state = store.getState()
    // The stale row still restores — it just cannot mirror-mount (and resize) Grok's PTY.
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'stale-tab',
      'grok-tab'
    ])
    expect(state.pendingReconnectPtyIdByTabId).toEqual({
      'grok-tab': grokPtyId
    })
    expect(state.pendingReconnectTabByWorktree[WORKTREE_ID]).toEqual(['grok-tab'])
    expect(state.terminalLayoutsByTabId['grok-tab']?.ptyIdsByLeafId).toEqual({
      'terminal:grok': grokPtyId
    })
    expect(state.terminalLayoutsByTabId['stale-tab']?.ptyIdsByLeafId).toEqual({})
    // Regression (#13098): the row must survive the next persist too, not just hydration.
    expect(
      buildWorkspaceSessionPayload(state).tabsByWorktree[WORKTREE_ID]?.map((t) => t.id)
    ).toEqual(['stale-tab', 'grok-tab'])
  })

  it('strips a duplicated relay session id from the non-canonical row only', () => {
    const store = createTestStore()
    seedWorktree(store)
    const relayId = 'relay-session-grok'

    store.getState().hydrateWorkspaceSession(
      baseSession({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            makeTab({ id: 'stale-tab', worktreeId: WORKTREE_ID, sortOrder: 0 }),
            makeTab({ id: 'grok-tab', worktreeId: WORKTREE_ID, sortOrder: 1 })
          ]
        },
        remoteSessionIdsByTabId: { 'stale-tab': relayId, 'grok-tab': relayId },
        unifiedTabs: {
          [WORKTREE_ID]: [unifiedTerminalTab('grok-tab', 'Grok', 0)]
        }
      })
    )

    const state = store.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'stale-tab',
      'grok-tab'
    ])
    expect(state.pendingReconnectPtyIdByTabId).toEqual({ 'grok-tab': relayId })
    expect(state.pendingReconnectTabByWorktree[WORKTREE_ID]).toEqual(['grok-tab'])
  })

  it('restores non-canonical legacy rows that own their own PTY (regression: #13098)', () => {
    const store = createTestStore()
    seedWorktree(store)

    store.getState().hydrateWorkspaceSession(
      baseSession({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            makeTab({
              id: 'grok-tab',
              worktreeId: WORKTREE_ID,
              ptyId: 'pty-grok',
              sortOrder: 0
            }),
            makeTab({
              id: 'legacy-tab',
              worktreeId: WORKTREE_ID,
              ptyId: 'pty-legacy',
              sortOrder: 1
            })
          ]
        },
        terminalLayoutsByTabId: {
          'grok-tab': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:grok': 'pty-grok' }
          },
          'legacy-tab': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:legacy': 'pty-legacy' }
          }
        },
        // Only the Grok tab has a unified row; the legacy tab must survive anyway.
        unifiedTabs: {
          [WORKTREE_ID]: [unifiedTerminalTab('grok-tab', 'Grok', 0)]
        }
      })
    )

    const state = store.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'grok-tab',
      'legacy-tab'
    ])
    expect(state.pendingReconnectTabByWorktree[WORKTREE_ID]).toEqual(['grok-tab', 'legacy-tab'])
    expect(state.pendingReconnectPtyIdByTabId).toEqual({
      'grok-tab': 'pty-grok',
      'legacy-tab': 'pty-legacy'
    })
    expect(state.terminalLayoutsByTabId['legacy-tab']?.ptyIdsByLeafId).toEqual({
      'terminal:legacy': 'pty-legacy'
    })
  })

  it('restores every row of a legacy session that has no unified tabs at all', () => {
    const store = createTestStore()
    seedWorktree(store)

    store.getState().hydrateWorkspaceSession(
      baseSession({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            makeTab({
              id: 'legacy-a',
              worktreeId: WORKTREE_ID,
              ptyId: 'pty-a',
              sortOrder: 0
            }),
            makeTab({
              id: 'legacy-b',
              worktreeId: WORKTREE_ID,
              ptyId: 'pty-b',
              sortOrder: 1
            })
          ]
        },
        terminalLayoutsByTabId: {
          'legacy-a': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:a': 'pty-a' }
          },
          'legacy-b': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:b': 'pty-b' }
          }
        }
      })
    )

    const state = store.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'legacy-a',
      'legacy-b'
    ])
    expect(state.pendingReconnectPtyIdByTabId).toEqual({
      'legacy-a': 'pty-a',
      'legacy-b': 'pty-b'
    })
    expect(state.pendingReconnectTabByWorktree[WORKTREE_ID]).toEqual(['legacy-a', 'legacy-b'])
    expect(state.terminalLayoutsByTabId['legacy-b']?.ptyIdsByLeafId).toEqual({
      'terminal:b': 'pty-b'
    })
  })

  it('keeps a split leaf that only the legacy row owns while dropping the shared one', () => {
    const store = createTestStore()
    seedWorktree(store)
    const sharedPtyId = 'daemon-session-shared'

    store.getState().hydrateWorkspaceSession(
      baseSession({
        tabsByWorktree: {
          [WORKTREE_ID]: [
            makeTab({
              id: 'grok-tab',
              worktreeId: WORKTREE_ID,
              ptyId: sharedPtyId,
              sortOrder: 0
            }),
            makeTab({
              id: 'legacy-tab',
              worktreeId: WORKTREE_ID,
              sortOrder: 1
            })
          ]
        },
        terminalLayoutsByTabId: {
          'grok-tab': {
            ...makeLayout(),
            ptyIdsByLeafId: { 'terminal:grok': sharedPtyId }
          },
          'legacy-tab': {
            ...makeLayout(),
            ptyIdsByLeafId: {
              'terminal:mirror': sharedPtyId,
              'terminal:own': 'pty-own'
            }
          }
        },
        unifiedTabs: {
          [WORKTREE_ID]: [unifiedTerminalTab('grok-tab', 'Grok', 0)]
        }
      })
    )

    const state = store.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'grok-tab',
      'legacy-tab'
    ])
    expect(state.terminalLayoutsByTabId['legacy-tab']?.ptyIdsByLeafId).toEqual({
      'terminal:own': 'pty-own'
    })
    expect(state.terminalLayoutsByTabId['grok-tab']?.ptyIdsByLeafId).toEqual({
      'terminal:grok': sharedPtyId
    })
  })
})
