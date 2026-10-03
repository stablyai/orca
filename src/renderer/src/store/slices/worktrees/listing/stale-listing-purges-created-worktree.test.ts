import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectedWorktree, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeCatalogVersion } from '../../../../../../shared/worktree/catalog-version'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { applyCreatedWorktree } from '../create/created-worktree-state-merge'
import { worktreeCatalogVersionKey } from './worktree-catalog-version-state'
import { mergeFetchedWorktrees } from './fetched-worktree-merge'
import type { WorktreeListingMergeOutcome } from './detected-worktree-refresh-admission'
import {
  TEST_REPO,
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '../../store-test-helpers'
import { createStoreCascadesMockApi } from '../../store-cascades-test-harness'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/structured-agent-session-launch-persistence'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  resetStructuredAgentLaunchRegistryForTests
} from '@/lib/structured-agent-session-launch-registry'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

createStoreCascadesMockApi()

const REPO_ID = TEST_REPO.id
const EXISTING_ID = `${REPO_ID}::/tmp/wt-existing`
const CREATED_ID = `${REPO_ID}::/tmp/wt-created`
const SESSION_ID = 'claude_repro_session'
const AGENT_TAB_ID = `agent-session:${SESSION_ID}`

function detected(worktree: Worktree): DetectedWorktree {
  return { ...worktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }
}

function seedCreatedWorkspaceWithPendingLaunch(
  store: ReturnType<typeof createTestStore>,
  detectedIncludesCreated: boolean
): void {
  const existing = makeWorktree({ id: EXISTING_ID, repoId: REPO_ID, path: '/tmp/wt-existing' })
  const created = makeWorktree({ id: CREATED_ID, repoId: REPO_ID, path: '/tmp/wt-created' })
  seedStore(store, {
    worktreesByRepo: { [REPO_ID]: [existing, created] },
    detectedWorktreesByRepo: {
      [REPO_ID]: {
        repoId: REPO_ID,
        authoritative: true,
        source: 'git',
        worktrees: detectedIncludesCreated
          ? [detected(existing), detected(created)]
          : [detected(existing)]
      }
    },
    tabsByWorktree: {
      [CREATED_ID]: [makeTab({ id: 'term-1', worktreeId: CREATED_ID, ptyId: 'pty-1' })]
    },
    ptyIdsByTabId: { 'term-1': ['pty-1'] },
    unifiedTabsByWorktree: {
      [CREATED_ID]: [
        {
          id: 'term-1',
          entityId: 'term-1',
          groupId: 'group-1',
          worktreeId: CREATED_ID,
          contentType: 'terminal',
          label: 'Terminal 1',
          customLabel: 'Setup',
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        {
          id: AGENT_TAB_ID,
          entityId: SESSION_ID,
          groupId: 'group-1',
          worktreeId: CREATED_ID,
          contentType: 'agent-session',
          agentSessionAgent: 'claude',
          label: 'Claude Chat',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
    },
    groupsByWorktree: {
      [CREATED_ID]: [
        {
          id: 'group-1',
          worktreeId: CREATED_ID,
          activeTabId: AGENT_TAB_ID,
          tabOrder: ['term-1', AGENT_TAB_ID]
        }
      ]
    },
    activeGroupIdByWorktree: { [CREATED_ID]: 'group-1' },
    activeWorktreeId: CREATED_ID,
    activeWorkspaceKey: `worktree:${CREATED_ID}`,
    activeView: 'terminal',
    refreshGitHubForWorktree: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
  // The provisional Claude launch: host create RPC in flight, nothing published yet.
  writeStructuredAgentLaunchRecord({
    sessionId: SESSION_ID,
    agent: 'claude',
    lifecycle: 'pending',
    clientOperationId: 'op-1',
    payloadFingerprint: 'fp-1',
    expectedRuntimeFence: null
  })
}

function applyListing(
  store: ReturnType<typeof createTestStore>,
  rows: Worktree[],
  catalogVersion?: WorktreeCatalogVersion
): WorktreeListingMergeOutcome {
  return mergeFetchedWorktrees(store.setState, {
    repoId: REPO_ID,
    hostId: 'local',
    ownerWasMissingAtStart: false,
    requestStartedWorktrees: store.getState().worktreesByRepo[REPO_ID],
    refresh: {
      status: 'admitted',
      executionHostId: 'local',
      result: {
        repoId: REPO_ID,
        authoritative: true,
        source: 'git',
        worktrees: rows.map(detected),
        ...(catalogVersion ? { catalogVersion } : {})
      }
    }
  })
}

// Why this suite exists: it pins what an authoritative listing that omits a known worktree does to
// the client, which is exactly why the host re-runs a scan that a create overtook instead of
// publishing it (see detected-provider-listing.ts). The client keeps no fence of its own.
describe('an authoritative listing that omits a just-created worktree', () => {
  beforeEach(() => {
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
  })

  it('cancels its pending structured launch, wipes its tabs and clears the selection (detected already knew it)', () => {
    const store = createTestStore()
    seedCreatedWorkspaceWithPendingLaunch(store, true)
    const existingRow = store.getState().worktreesByRepo[REPO_ID]![0]!

    expect(applyListing(store, [existingRow])).toBe('applied')

    const state = store.getState()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(true)
    expect(state.activeWorktreeId).toBeNull()
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toBeUndefined()
    expect(state.tabsByWorktree[CREATED_ID]).toBeUndefined()
  })

  it('does the same when only its tabs made it "known" (hydration purge never completed)', () => {
    const store = createTestStore()
    seedCreatedWorkspaceWithPendingLaunch(store, false)
    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    const existingRow = store.getState().worktreesByRepo[REPO_ID]![0]!

    expect(applyListing(store, [existingRow])).toBe('applied')

    const state = store.getState()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(true)
    expect(state.activeWorktreeId).toBeNull()
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toBeUndefined()
  })

  it('control: a listing that includes the created worktree leaves everything intact', () => {
    const store = createTestStore()
    seedCreatedWorkspaceWithPendingLaunch(store, true)
    const rows = store.getState().worktreesByRepo[REPO_ID]!

    expect(applyListing(store, [...rows])).toBe('applied')

    const state = store.getState()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(false)
    expect(state.activeWorktreeId).toBe(CREATED_ID)
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toHaveLength(2)
  })
})

// Why this suite exists: the host stamps every listing with the catalog version its scan began
// at and every create reply with the version the create produced. A listing that predates an
// applied create is not applied at all, whatever delayed it -- host post-scan work, a coalesced
// joiner, or the pre-merge terminal teardown -- so it can neither purge the new worktree nor
// replace the host's rows with a list that lacks it.
describe('a listing versioned before an applied create', () => {
  const HOST = 'host-epoch-1'
  const before = { epoch: HOST, sequence: 6 }
  const createReply = { epoch: HOST, sequence: 7 }
  const after = { epoch: HOST, sequence: 8 }

  beforeEach(() => {
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
  })

  function seedWithAppliedCreate(store: ReturnType<typeof createTestStore>) {
    seedCreatedWorkspaceWithPendingLaunch(store, true)
    const created = store.getState().worktreesByRepo[REPO_ID]![1]!
    applyCreatedWorktree(store.setState, REPO_ID, {
      worktree: created,
      catalogVersion: createReply
    } satisfies CreateWorktreeResult)
    expect(
      store.getState().worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey(REPO_ID, 'local')]
    ).toEqual(createReply)
  }

  it('is not applied: no purge, no tombstone, rows and selection untouched', () => {
    const store = createTestStore()
    seedWithAppliedCreate(store)
    const existingRow = store.getState().worktreesByRepo[REPO_ID]![0]!

    expect(applyListing(store, [existingRow], before)).toBe('superseded')

    const state = store.getState()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(false)
    expect(state.activeWorktreeId).toBe(CREATED_ID)
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toHaveLength(2)
    expect(state.worktreesByRepo[REPO_ID]!.map((w) => w.id)).toEqual([EXISTING_ID, CREATED_ID])
    expect(state.detectedWorktreesByRepo[REPO_ID]!.worktrees.map((w) => w.id)).toContain(CREATED_ID)
  })

  it('reports a listing whose repo owner went away as not-current, even when also older', () => {
    const store = createTestStore()
    seedWithAppliedCreate(store)
    store.setState({ repos: [] })
    const existingRow = store.getState().worktreesByRepo[REPO_ID]![0]!

    expect(applyListing(store, [existingRow], before)).toBe('not-current')

    expect(store.getState().unifiedTabsByWorktree[CREATED_ID]).toHaveLength(2)
  })

  it('a later listing that includes the worktree applies and advances the version', () => {
    const store = createTestStore()
    seedWithAppliedCreate(store)
    const rows = store.getState().worktreesByRepo[REPO_ID]!

    expect(applyListing(store, [...rows], after)).toBe('applied')

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(CREATED_ID)
    expect(
      state.worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey(REPO_ID, 'local')]
    ).toEqual(after)
  })

  it('a listing from a restarted host is a new catalog, not an older one', () => {
    const store = createTestStore()
    seedWithAppliedCreate(store)
    const rows = store.getState().worktreesByRepo[REPO_ID]!
    const restarted = { epoch: 'host-epoch-2', sequence: 1 }

    expect(applyListing(store, [...rows], restarted)).toBe('applied')

    expect(
      store.getState().worktreeCatalogVersionByRepoHost[worktreeCatalogVersionKey(REPO_ID, 'local')]
    ).toEqual(restarted)
  })

  it('an unstamped listing from an older host keeps the pre-stamp behavior', () => {
    const store = createTestStore()
    seedWithAppliedCreate(store)
    const existingRow = store.getState().worktreesByRepo[REPO_ID]![0]!

    expect(applyListing(store, [existingRow])).toBe('applied')

    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(true)
    expect(store.getState().activeWorktreeId).toBeNull()
  })
})
