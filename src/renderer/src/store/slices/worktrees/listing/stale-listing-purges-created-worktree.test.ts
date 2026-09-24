import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectedWorktree, Worktree } from '../../../../../../shared/worktree/types'
import { mergeFetchedWorktrees } from './fetched-worktree-merge'
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

function applyListing(store: ReturnType<typeof createTestStore>, rows: Worktree[]): boolean {
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
        worktrees: rows.map(detected)
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

    expect(applyListing(store, [existingRow])).toBe(true)

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

    expect(applyListing(store, [existingRow])).toBe(true)

    const state = store.getState()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(true)
    expect(state.activeWorktreeId).toBeNull()
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toBeUndefined()
  })

  it('control: a listing that includes the created worktree leaves everything intact', () => {
    const store = createTestStore()
    seedCreatedWorkspaceWithPendingLaunch(store, true)
    const rows = store.getState().worktreesByRepo[REPO_ID]!

    expect(applyListing(store, [...rows])).toBe(true)

    const state = store.getState()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)).toBe(false)
    expect(state.activeWorktreeId).toBe(CREATED_ID)
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toHaveLength(2)
  })
})
