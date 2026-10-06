// A losing tab has a second route back to the PTY its layout just gave up: its own row
// `ptyId`, which reconnect copies back onto the row and the pane then takes as a fallback.
// This drives the real hydration entry with the STA-7961 pair to pin both routes shut.
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
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

import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'

const WORKTREE_ID = 'repo1::/wt-1'
const SPLIT_TAB_ID = 'eba00a9a-17df-4152-8258-42381b48890a'
const SINGLE_TAB_ID = '881a9ee2-7143-46c8-98ac-8ffbb9cf4b2c'
const SHARED_LEAF_ID = '10cb5648-8a54-41c0-a6a4-ef0028d93599'
const OWN_LEAF_ID = 'df8913c9-fd8a-420a-a7d6-17daf0ed30f0'
const SHARED_PTY_ID = 'repo1::/wt-1@@289ed0f2'
const SPLIT_OWN_PTY_ID = 'repo1::/wt-1@@eaff6e99'

/** The persisted pair from the report: both tabs bind the same leaf to the same PTY. */
function duplicateLeafSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: SINGLE_TAB_ID,
    activeWorktreeIdsOnShutdown: [WORKTREE_ID],
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({
          id: SPLIT_TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId: SPLIT_OWN_PTY_ID,
          sortOrder: 0,
          createdAt: 1_789_867_969_623
        }),
        makeTab({
          id: SINGLE_TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId: SHARED_PTY_ID,
          sortOrder: 1,
          createdAt: 1_789_867_969_624
        })
      ]
    },
    terminalLayoutsByTabId: {
      [SPLIT_TAB_ID]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: OWN_LEAF_ID },
          second: { type: 'leaf', leafId: SHARED_LEAF_ID }
        },
        activeLeafId: SHARED_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [OWN_LEAF_ID]: SPLIT_OWN_PTY_ID, [SHARED_LEAF_ID]: SHARED_PTY_ID }
      },
      [SINGLE_TAB_ID]: {
        root: { type: 'leaf', leafId: SHARED_LEAF_ID },
        activeLeafId: SHARED_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SHARED_LEAF_ID]: SHARED_PTY_ID }
      }
    }
  }
}

function hydrate(): ReturnType<ReturnType<typeof createTestStore>['getState']> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
    }
  })
  store.getState().hydrateWorkspaceSession(duplicateLeafSession())
  return store.getState()
}

describe('hydrating the STA-7961 duplicate binding', () => {
  it('leaves the shared pty bound to one tab only', () => {
    const state = hydrate()

    expect(state.terminalLayoutsByTabId[SPLIT_TAB_ID]?.ptyIdsByLeafId?.[SHARED_LEAF_ID]).toBe(
      SHARED_PTY_ID
    )
    expect(
      Object.values(state.terminalLayoutsByTabId[SINGLE_TAB_ID]?.ptyIdsByLeafId ?? {})
    ).not.toContain(SHARED_PTY_ID)
  })

  it('keeps the losing row from taking the pty back through its tab-level id', () => {
    const state = hydrate()

    expect(state.pendingReconnectPtyIdByTabId[SINGLE_TAB_ID]).toBeUndefined()
    expect(
      state.tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === SINGLE_TAB_ID)?.ptyId
    ).not.toBe(SHARED_PTY_ID)
  })

  it('still reconnects a row whose own pty nothing else claims', () => {
    const state = hydrate()

    expect(state.pendingReconnectPtyIdByTabId[SPLIT_TAB_ID]).toBe(SPLIT_OWN_PTY_ID)
  })

  it('keeps the losing tab and its pane', () => {
    const state = hydrate()

    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      SPLIT_TAB_ID,
      SINGLE_TAB_ID
    ])
    expect(state.terminalLayoutsByTabId[SINGLE_TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: SHARED_LEAF_ID
    })
  })
})
