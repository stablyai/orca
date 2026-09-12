import { expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { DetectedWorktree } from '../../../../shared/worktree/types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: {} }

import { createTestStore, makeTab, makeWorktree, TEST_REPO } from './store-test-helpers'
import { buildValidWorktreeIdsForSessionHydration } from './degraded-repo-worktree-validity'

const CHECKOUT_ID = `${TEST_REPO.id}::/repo1`
const HIDDEN_ID = `${TEST_REPO.id}::/repo1/.claude/worktrees/lane-a`
const HIDDEN_TAB_ID = 'terminal-lane-a'

function makeDetectedWorktree(
  overrides: Partial<DetectedWorktree> & { id: string; path: string }
): DetectedWorktree {
  return {
    ...makeWorktree({ id: overrides.id, repoId: TEST_REPO.id, path: overrides.path }),
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: false,
    ...overrides
  }
}

/** The catalog shape a repo with one visible checkout plus one hidden agent-scratch worktree
 *  produces: `worktreesByRepo` carries only the visible rows, the authoritative scan carries both. */
function seedHiddenWorktreeCatalog(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: CHECKOUT_ID, repoId: TEST_REPO.id, path: '/repo1' })]
    },
    detectedWorktreesByRepo: {
      [TEST_REPO.id]: {
        repoId: TEST_REPO.id,
        authoritative: true,
        source: 'git',
        worktrees: [
          makeDetectedWorktree({
            id: CHECKOUT_ID,
            path: '/repo1',
            ownership: 'external',
            selectedCheckout: true,
            visible: true
          }),
          makeDetectedWorktree({ id: HIDDEN_ID, path: '/repo1/.claude/worktrees/lane-a' })
        ]
      }
    }
  })
}

function makeHiddenWorktreeSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO.id,
    tabsByWorktree: {
      [HIDDEN_ID]: [makeTab({ id: HIDDEN_TAB_ID, worktreeId: HIDDEN_ID, ptyId: 'pty-lane-a' })]
    }
  }
}

it('keeps a hidden worktree valid when the authoritative scan still lists it', () => {
  const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
    {
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [{ id: CHECKOUT_ID }] },
      detectedWorktreesByRepo: {
        [TEST_REPO.id]: {
          authoritative: true,
          worktrees: [
            makeDetectedWorktree({ id: CHECKOUT_ID, path: '/repo1', visible: true }),
            makeDetectedWorktree({ id: HIDDEN_ID, path: '/repo1/.claude/worktrees/lane-a' })
          ]
        }
      }
    },
    [HIDDEN_ID]
  )

  expect([...validWorktreeIds]).toContain(HIDDEN_ID)
})

it('still treats a worktree the authoritative scan dropped as deleted', () => {
  const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
    {
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [{ id: CHECKOUT_ID }] },
      detectedWorktreesByRepo: {
        [TEST_REPO.id]: {
          authoritative: true,
          worktrees: [makeDetectedWorktree({ id: CHECKOUT_ID, path: '/repo1', visible: true })]
        }
      }
    },
    [HIDDEN_ID]
  )

  expect([...validWorktreeIds]).not.toContain(HIDDEN_ID)
})

it('restores terminal tabs of a worktree hidden from the sidebar (#15227)', () => {
  const store = createTestStore()
  seedHiddenWorktreeCatalog(store)
  const session = makeHiddenWorktreeSession()

  store.getState().hydrateWorkspaceSession(session)
  store.getState().hydrateTabsSession(session)

  const state = store.getState()
  expect(state.tabsByWorktree[HIDDEN_ID]?.map((tab) => tab.id)).toEqual([HIDDEN_TAB_ID])
})

it('keeps a hidden worktree tab through a hydrate/persist round trip (#15227)', () => {
  const firstStore = createTestStore()
  seedHiddenWorktreeCatalog(firstStore)
  const session = makeHiddenWorktreeSession()
  firstStore.getState().hydrateWorkspaceSession(session)
  firstStore.getState().hydrateTabsSession(session)

  // Why: the write path replaces the persisted map wholesale, so a tab dropped during hydration
  // is erased from disk by the next session write even though its PTY is still running.
  const persisted = { ...session, tabsByWorktree: firstStore.getState().tabsByWorktree }
  const restoredStore = createTestStore()
  seedHiddenWorktreeCatalog(restoredStore)
  restoredStore.getState().hydrateWorkspaceSession(persisted)
  restoredStore.getState().hydrateTabsSession(persisted)

  expect(restoredStore.getState().tabsByWorktree[HIDDEN_ID]?.map((tab) => tab.id)).toEqual([
    HIDDEN_TAB_ID
  ])
})
