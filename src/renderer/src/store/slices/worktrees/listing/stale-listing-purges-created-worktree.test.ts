import { useAppStore } from '@/store'
import * as launchRecords from '@/lib/structured-agent-session-launch-persistence'
import { parseDesktopCreateLaunchRecord } from '@/lib/structured-agent-session-launch-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetectedWorktree, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getEnvironmentSshStateGeneration } from '../../runtime-environment-ssh'
import {
  getRuntimeEnvironmentConnectionGeneration,
  advanceRuntimeEnvironmentConnectionGeneration
} from '../../runtime-status-connection-generation'
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
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/structured-agent-session-launch-persistence'
import { wasStructuredAgentLaunchClosedByLocalCancel } from '@/lib/structured-agent-session-local-launch-cancel'
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

// A layout-owner build closes a local launch on its host at once and keeps no tombstone.
function launchWasCancelled(): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? wasStructuredAgentLaunchClosedByLocalCancel(SESSION_ID) &&
        readStructuredAgentLaunchRecord(SESSION_ID) === undefined
    : hasStructuredAgentSessionLaunchCancellationTombstone(CREATED_ID, SESSION_ID)
}

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
    executionHostId: 'local',
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
  catalogVersion?: WorktreeCatalogVersion,
  hostId: ExecutionHostId = 'local',
  runtimeAuthority?: {
    environmentId: string
    connectionGeneration: number
    runtimeConnectionGeneration: number
  }
): WorktreeListingMergeOutcome {
  return mergeFetchedWorktrees(store.setState, store.getState, {
    repoId: REPO_ID,
    hostId,
    ownerWasMissingAtStart: false,
    requestStartedWorktrees: store.getState().worktreesByRepo[REPO_ID],
    refresh: {
      status: 'admitted',
      executionHostId: hostId,
      runtimeAuthority,
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
    expect(launchWasCancelled()).toBe(true)
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
    expect(launchWasCancelled()).toBe(true)
    expect(state.activeWorktreeId).toBeNull()
    expect(state.unifiedTabsByWorktree[CREATED_ID]).toBeUndefined()
  })

  it('control: a listing that includes the created worktree leaves everything intact', () => {
    const store = createTestStore()
    seedCreatedWorkspaceWithPendingLaunch(store, true)
    const rows = store.getState().worktreesByRepo[REPO_ID]!

    expect(applyListing(store, [...rows])).toBe('applied')

    const state = store.getState()
    expect(readStructuredAgentLaunchRecord(SESSION_ID)).toBeDefined()
    expect(launchWasCancelled()).toBe(false)
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
    expect(readStructuredAgentLaunchRecord(SESSION_ID)).toBeDefined()
    expect(launchWasCancelled()).toBe(false)
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

    expect(launchWasCancelled()).toBe(true)
    expect(store.getState().activeWorktreeId).toBeNull()
  })
})

it('associates a missed outer reply from accepted catalog rows with bounded keyed work, including unchanged rows', () => {
  const read = vi.spyOn(launchRecords, 'readStructuredAgentLaunchRecord')
  const globals = vi.spyOn(useAppStore, 'getState')
  try {
    for (const size of [10, 100]) {
      resetStructuredAgentLaunchPersistenceForTests()
      const store = createTestStore()
      seedStore(store, { repos: [TEST_REPO] })
      globals.mockImplementation(store.getState)
      const instanceId = '94d38a16-e9db-4e86-b81d-334788958124'
      const rows = Array.from({ length: size }, (_, i) =>
        makeWorktree({
          id: `${REPO_ID}::/tmp/perf-${i}`,
          path: `/tmp/perf-${i}`,
          repoId: REPO_ID,
          instanceId: i === 0 ? instanceId : `unrelated-${i}`
        })
      )
      read.mockClear()
      expect(applyListing(store, rows)).toBe('applied')
      expect(read.mock.calls.filter(([key]) => key.startsWith('desktop-create:'))).toHaveLength(0)
      const sessionId = 'claude_11111111_2222_4333_8444_555555555555'
      const record = parseDesktopCreateLaunchRecord({
        sessionId,
        executionHostId: 'local',
        agent: 'claude',
        lifecycle: 'visibility-unknown',
        desktopCreate: {
          params: {
            agent: 'claude',
            operationId: '1790000000123-0123456789abcdef0123456789abcdef',
            sessionId,
            paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            surface: 'chat',
            createIdentity: { instanceId },
            target: { kind: 'create-worktree', create: { repo: REPO_ID, name: 'task' } },
            prompt: { text: 'host-owned A', delivery: 'submit' }
          }
        }
      })
      if (!record) {
        throw new Error('outer record invalid')
      }
      writeStructuredAgentLaunchRecord(record)
      read.mockClear()
      expect(applyListing(store, rows)).toBe('applied')
      expect(
        read.mock.calls.filter(([key]) => key.startsWith('desktop-create:')).length
      ).toBeLessThanOrEqual(size)
      expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject({
        lifecycle: 'visibility-unknown',
        desktopCreate: { worktreeId: rows[0]!.id },
        surfaceAddress: { worktreeId: rows[0]!.id }
      })
      expect(store.getState().unifiedTabsByWorktree[rows[0]!.id]).toEqual([
        expect.objectContaining({
          contentType: 'agent-session',
          entityId: sessionId,
          executionHostId: 'local'
        })
      ])
      expect(store.getState().activeWorktreeId).toBeNull()
      expect(applyListing(store, rows)).toBe('applied')
      expect(store.getState().unifiedTabsByWorktree[rows[0]!.id]).toHaveLength(1)
    }
  } finally {
    read.mockRestore()
    globals.mockRestore()
    resetStructuredAgentLaunchPersistenceForTests()
  }
})

it('keeps lost outer replies unknown through admitted catalog, publication, reload and close; only deliberate Replay checks the same request', async () => {
  const rpcModule = await import('@/runtime/runtime-rpc-client')
  const { RuntimeRpcCallError } = await import('@/runtime/runtime-rpc-result')
  const { issueDesktopCreateLaunch } = await import('@/lib/structured-agent-session-desktop-create')
  const { retryStructuredAgentSessionLaunch } =
    await import('@/lib/structured-agent-session-launch')
  const { recheckUnconfirmedStructuredAgentLaunches } =
    await import('@/lib/structured-agent-session-launch-unconfirmed-recheck')
  const { markStructuredAgentSessionLaunchPublished } =
    await import('@/lib/structured-agent-session-launch-publication')
  const { getStructuredAgentSessionLaunchLifecycle } =
    await import('@/lib/structured-agent-session-launch-registry')
  const { deriveAgentLaunchChildOperationId } =
    await import('../../../../../../shared/agent-launch-child-operation')
  const store = createTestStore()
  seedStore(store, { repos: [TEST_REPO] })
  const globalState = vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  const rpc = vi.spyOn(rpcModule, 'callRuntimeRpc').mockImplementation(async () => ({}))
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  })
  resetStructuredAgentLaunchPersistenceForTests()
  const sessionId = 'claude_11111111_2222_4333_8444_555555555555'
  const instanceId = '94d38a16-e9db-4e86-b81d-334788958124'
  const record = parseDesktopCreateLaunchRecord({
    sessionId,
    executionHostId: 'local',
    agent: 'claude',
    lifecycle: 'visibility-unknown',
    desktopCreate: {
      params: {
        agent: 'claude',
        sessionId,
        surface: 'chat',
        createIdentity: { instanceId },
        operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        target: { kind: 'create-worktree', create: { repo: REPO_ID, name: 'task' } },
        prompt: { text: 'host A', delivery: 'submit' }
      }
    }
  })
  if (!record) {
    throw new Error('outer record invalid')
  }
  const row = makeWorktree({ id: CREATED_ID, path: '/tmp/wt-created', repoId: REPO_ID, instanceId })
  try {
    writeStructuredAgentLaunchRecord(record)
    rpc.mockRejectedValueOnce(new Error('whole RPC reply lost'))
    await expect(issueDesktopCreateLaunch(record, { kind: 'local' })).rejects.toThrow(
      'whole RPC reply lost'
    )
    expect(applyListing(store, [row])).toBe('applied')
    expect(getStructuredAgentSessionLaunchLifecycle(CREATED_ID, sessionId)).toBe(
      'visibility-unknown'
    )
    expect(store.getState().unifiedTabsByWorktree[CREATED_ID]).toEqual([
      expect.objectContaining({ entityId: sessionId })
    ])
    markStructuredAgentSessionLaunchPublished(CREATED_ID, sessionId, 'local')
    expect(readStructuredAgentLaunchRecord(sessionId)?.desktopCreate).toBeDefined()
    recheckUnconfirmedStructuredAgentLaunches('local')
    resetStructuredAgentLaunchPersistenceForTests()
    expect(readStructuredAgentLaunchRecord(sessionId)?.lifecycle).toBe('visibility-unknown')
    expect(applyListing(store, [row])).toBe('applied')
    expect(rpc).toHaveBeenCalledTimes(1)
    let reply!: (value: unknown) => void
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    expect(retryStructuredAgentSessionLaunch(CREATED_ID, sessionId)).toBe(true)
    expect(retryStructuredAgentSessionLaunch(CREATED_ID, sessionId)).toBe(false)
    expect(rpc.mock.calls[1]?.[1]).toBe('agent.launchReplay')
    expect(rpc.mock.calls[1]?.[2]).toEqual(record.desktopCreate.params)
    // Actual close retires the saved owner before the late result; no transient input is re-staged.
    store.getState().closeUnifiedTab(`structured-agent-session-${sessionId}`)
    expect(readStructuredAgentLaunchRecord(sessionId)).toBeUndefined()
    const child = deriveAgentLaunchChildOperationId(record.desktopCreate.params.operationId)!
    reply({
      worktreeId: CREATED_ID,
      outcome: { kind: 'structured', sessionId, handle: 'chat' },
      receipt: { mode: 'structured', preferred: 'structured', reason: 'requested', detail: 'Chat' },
      prompt: {
        text: 'host A',
        delivery: 'submit',
        outcome: 'journaled',
        messageId: deriveAgentLaunchChildOperationId(child)
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readStructuredAgentLaunchRecord(sessionId)).toBeUndefined()
    expect(
      rpc.mock.calls.filter(
        ([, method]) => method === 'agentSession.create' || method === 'agentSession.send'
      )
    ).toHaveLength(0)
    // Independent single-fault fixture: a delivered W survives lost instance metadata.
    storage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    seedStore(store, { worktreesByRepo: {}, unifiedTabsByWorktree: {}, groupsByWorktree: {} })
    writeStructuredAgentLaunchRecord(record)
    rpc.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'actual-W',
        ok: false,
        error: {
          code: 'agent_session_operation_unknown',
          message: 'unknown',
          data: { desktopCreate: { worktreeId: CREATED_ID } }
        }
      })
    )
    rpc.mockResolvedValueOnce({ worktree: { ...row, instanceId: undefined } })
    const merge = vi.spyOn(useAppStore, 'setState').mockImplementation(store.setState)
    const refresh = vi.spyOn(store.getState(), 'fetchWorktrees').mockResolvedValue(true)
    let observerThrew = false
    const stopObserver = store.subscribe((state) => {
      if (
        !observerThrew &&
        state.unifiedTabsByWorktree[CREATED_ID]?.some((tab) => tab.entityId === sessionId)
      ) {
        observerThrew = true
        throw new Error('presentation observer failed after tab installation')
      }
    })
    try {
      await expect(issueDesktopCreateLaunch(record, { kind: 'local' })).rejects.toThrow('unknown')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(observerThrew).toBe(true)
      expect(store.getState().getKnownWorktreeById(CREATED_ID, 'local')).toBeDefined()
      expect(rpc.mock.calls.some(([, method]) => method === 'worktree.show')).toBe(true)
    } finally {
      stopObserver()
      merge.mockRestore()
      refresh.mockRestore()
    }
    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject({
      lifecycle: 'visibility-unknown',
      desktopCreate: { worktreeId: CREATED_ID }
    })
    resetStructuredAgentLaunchPersistenceForTests()
    expect(applyListing(store, [{ ...row, instanceId: undefined }])).toBe('applied')
    expect(readStructuredAgentLaunchRecord(sessionId)?.desktopCreate?.worktreeId).toBe(CREATED_ID)
    const frozenMetadataRetry = structuredClone(
      readStructuredAgentLaunchRecord(sessionId)?.desktopCreate?.params
    )
    const beforeMetadataRetry = rpc.mock.calls.length
    rpc.mockRejectedValueOnce(
      new RuntimeRpcCallError({
        id: 'metadata-retry',
        ok: false,
        error: { code: 'agent_session_operation_unknown', message: 'unknown' }
      })
    )
    expect(retryStructuredAgentSessionLaunch(CREATED_ID, sessionId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc.mock.calls.slice(beforeMetadataRetry)).toEqual([
      [
        { kind: 'local' },
        'agent.launchReplay',
        frozenMetadataRetry,
        expect.objectContaining({ beforeSend: expect.any(Function) })
      ]
    ])
    expect(
      rpc.mock.calls.some(
        ([, method]) => method === 'agentSession.create' || method === 'agentSession.send'
      )
    ).toBe(false)
    expect(readStructuredAgentLaunchRecord(sessionId)?.lifecycle).toBe('visibility-unknown')
    store.getState().closeUnifiedTab(`structured-agent-session-${sessionId}`)
    storage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    writeStructuredAgentLaunchRecord(record)
    let closed = false
    const stop = store.subscribe((state) => {
      if (
        !closed &&
        state.unifiedTabsByWorktree[CREATED_ID]?.some((tab) => tab.entityId === sessionId)
      ) {
        closed = true
        state.closeUnifiedTab(`structured-agent-session-${sessionId}`)
      }
    })
    try {
      expect(applyListing(store, [row])).toBe('applied')
      expect(closed).toBe(true)
      expect(readStructuredAgentLaunchRecord(sessionId)).toBeUndefined()
      resetStructuredAgentLaunchPersistenceForTests()
      expect(readStructuredAgentLaunchRecord(sessionId)).toBeUndefined()
      expect(applyListing(store, [row])).toBe('applied')
      expect(store.getState().unifiedTabsByWorktree[CREATED_ID] ?? []).toEqual([])
    } finally {
      stop()
    }
  } finally {
    rpc.mockRestore()
    globalState.mockRestore()
    resetStructuredAgentLaunchPersistenceForTests()
    vi.unstubAllGlobals()
  }
})

it('restores an outer paired launch only from current admitted catalog and manually replays its frozen request on that host', async () => {
  const rpcModule = await import('@/runtime/runtime-rpc-client')
  const { RuntimeRpcCallError } = await import('@/runtime/runtime-rpc-result')
  const { replaceRuntimeEnvironmentRevisions } =
    await import('@/runtime/runtime-environment-revision')
  const { restoreStructuredLaunchSurfaces } =
    await import('@/lib/structured-agent-session-launch-surface')
  const { retryStructuredAgentSessionLaunch } =
    await import('@/lib/structured-agent-session-launch')
  const { recheckUnconfirmedStructuredAgentLaunches } =
    await import('@/lib/structured-agent-session-launch-unconfirmed-recheck')
  const { stagedStructuredLaunchPrompts } =
    await import('@/lib/structured-agent-session-launch-prompt')
  const store = createTestStore()
  const hostId = 'runtime:outer-paired'
  const environmentId = 'outer-paired'
  seedStore(store, { repos: [{ ...TEST_REPO, executionHostId: hostId }] })
  const state = vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  const rpc = vi.spyOn(rpcModule, 'callRuntimeRpc').mockRejectedValue(
    new RuntimeRpcCallError({
      id: 'replay',
      ok: false,
      error: { code: 'agent_session_operation_expired', message: 'expired' }
    })
  )
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  })
  resetStructuredAgentLaunchPersistenceForTests()
  replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 21 }])
  const sessionId = 'codex_11111111_2222_4333_8444_555555555555'
  const instanceId = '94d38a16-e9db-4e86-b81d-334788958124'
  const record = parseDesktopCreateLaunchRecord({
    sessionId,
    executionHostId: hostId,
    agent: 'codex',
    lifecycle: 'pending',
    desktopCreate: {
      params: {
        agent: 'codex',
        sessionId,
        surface: 'chat',
        createIdentity: { instanceId },
        operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        target: { kind: 'create-worktree', create: { repo: REPO_ID, name: 'paired' } },
        prompt: { text: 'host A', delivery: 'submit' }
      }
    }
  })
  if (!record) {
    throw new Error('outer fixture invalid')
  }
  const row = makeWorktree({
    id: CREATED_ID,
    repoId: REPO_ID,
    path: '/tmp/wt-created',
    instanceId,
    hostId
  })
  const authority = {
    environmentId,
    connectionGeneration: getEnvironmentSshStateGeneration(environmentId),
    runtimeConnectionGeneration: getRuntimeEnvironmentConnectionGeneration(environmentId)
  }
  try {
    writeStructuredAgentLaunchRecord(record)
    resetStructuredAgentLaunchPersistenceForTests()
    restoreStructuredLaunchSurfaces()
    expect(store.getState().unifiedTabsByWorktree[CREATED_ID]).toBeUndefined()
    advanceRuntimeEnvironmentConnectionGeneration(environmentId)
    expect(applyListing(store, [row], undefined, hostId, authority)).toBe('not-current')
    expect(readStructuredAgentLaunchRecord(sessionId)?.desktopCreate?.worktreeId).toBeUndefined()
    const current = {
      ...authority,
      runtimeConnectionGeneration: getRuntimeEnvironmentConnectionGeneration(environmentId)
    }
    const version = { epoch: 'paired-host', sequence: 5 }
    expect(applyListing(store, [row], version, hostId, current)).toBe('applied')
    expect(store.getState().unifiedTabsByWorktree[CREATED_ID]).toEqual([
      expect.objectContaining({ entityId: sessionId, executionHostId: hostId })
    ])
    expect(applyListing(store, [], { ...version, sequence: 4 }, hostId, current)).toBe('superseded')
    resetStructuredAgentLaunchPersistenceForTests()
    recheckUnconfirmedStructuredAgentLaunches(hostId)
    expect(applyListing(store, [row], version, hostId, current)).toBe('applied')
    expect(rpc).not.toHaveBeenCalled()
    expect(stagedStructuredLaunchPrompts.has(sessionId)).toBe(false)
    expect(retryStructuredAgentSessionLaunch(CREATED_ID, sessionId)).toBe(true)
    expect(retryStructuredAgentSessionLaunch(CREATED_ID, sessionId)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId },
      'agent.launchReplay',
      record.desktopCreate.params,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 21 })
    )
    expect(readStructuredAgentLaunchRecord(sessionId)?.lifecycle).toBe('visibility-unknown')
    expect(store.getState().unifiedTabsByWorktree[CREATED_ID]).toHaveLength(1)
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 22 }], {
      retired: [environmentId],
      sameHost: []
    })
    expect(readStructuredAgentLaunchRecord(sessionId)).toBeUndefined()
    expect(retryStructuredAgentSessionLaunch(CREATED_ID, sessionId)).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(1)
  } finally {
    rpc.mockRestore()
    state.mockRestore()
    vi.unstubAllGlobals()
    resetStructuredAgentLaunchPersistenceForTests()
    replaceRuntimeEnvironmentRevisions([])
  }
})
