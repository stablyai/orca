import { beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '../../../store/slices/tabs/tabs-slice-test-harness'
import { projectWorktreeTabModelReconciliation } from '../../../store/slices/tabs/tabs-reconciliation'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { updateStructuredAgentLaunchRecords } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import type { StructuredAgentLaunchPersistedRecord } from '@/lib/agent-session/launch/structured-agent-session-launch-record'
import { holdEmptyWorkspaceDefaultSurfaceForLaunch } from '@/lib/workspace/activation/initial-surface/empty-workspace-default-surface-claims'
import type { StructuredLaunchState } from '@/lib/agent-session/launch/structured-agent-session-launch-state-store'
import type * as LaunchStateStore from '@/lib/agent-session/launch/structured-agent-session-launch-state-store'
import { hasStructuredAgentLaunchInWorktree } from '@/lib/agent-session/launch/structured-agent-session-launch-status'
import type { LayoutApplyReply } from '../../../../../shared/workspace-layout/workspace-layout-command-types'

const transport = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => transport)
const launches = vi.hoisted(() => {
  const state: { states: StructuredLaunchState[]; reads: number } = { states: [], reads: 0 }
  return state
})
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-state-store',
  async (original) => ({
    ...(await original<typeof LaunchStateStore>()),
    structuredLaunchStates: function* () {
      for (const state of launches.states) {
        launches.reads++
        yield state
      }
    }
  })
)

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => testStore.current!.getState() }
}))
vi.mock('../../hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: async ({ worktreeId }: { worktreeId: string }) => {
    const id = testStore.current!.getState().createTab(worktreeId)
    return { status: 'created', mirroredTabId: id }
  }
}))

createTabsSliceMockApi()
const { createInitialTerminalSeeder } = await import('./initial-terminal-seeder')
const { createInitialTerminalThroughLayoutOwner } =
  await import('../../../store/terminals/tabs/creation/terminal-tab-create-through-layout-owner')
const workspace = 'repo1::/tmp/agent-worktree'

// Guards #44127: automatic surface checks must skip unrelated inventories when already decided.
it.each([100, 1_000])('skips %i launch records without unresolved order entries', (population) => {
  const store = testStore.current!
  const groupId = store.getState().ensureWorktreeRootGroup(workspace)
  let launchReads = 0
  const records: StructuredAgentLaunchPersistedRecord[] = Array.from(
    { length: population },
    (_, index) => ({
      sessionId: index === 0 ? 'reserved-session' : `other-session-${index}`,
      get executionHostId() {
        launchReads++
        return 'local' as const
      },
      agent: 'codex',
      lifecycle: 'pending',
      clientOperationId: `operation-${index}`,
      payloadFingerprint: 'fingerprint',
      expectedRuntimeFence: null,
      surfaceAddress: {
        worktreeId: index === 0 ? workspace : 'repo1::/tmp/other',
        targetGroupId: groupId,
        precedingTabIds: []
      }
    })
  )
  updateStructuredAgentLaunchRecords(records.map((record) => [record.sessionId, record]))
  launchReads = 0
  try {
    expect(
      projectWorktreeTabModelReconciliation(store.getState(), workspace).renderableTabCount
    ).toBe(0)
    expect(launchReads).toBe(0)

    store.getState().createUnifiedTab(workspace, 'agent-session', {
      id: 'agent-chat',
      entityId: 'agent-session',
      agentSessionAgent: 'codex'
    })
    launchReads = 0
    expect(
      projectWorktreeTabModelReconciliation(store.getState(), workspace).renderableTabCount
    ).toBe(1)
    expect(launchReads).toBe(0)

    const group = store.getState().groupsByWorktree[workspace][0]
    store.setState({
      groupsByWorktree: {
        [workspace]: [
          {
            ...group,
            tabOrder: ['agent-chat', 'structured-agent-session-reserved-session', 'stale']
          }
        ]
      }
    })
    const reserved = projectWorktreeTabModelReconciliation(store.getState(), workspace)
    expect(reserved.patch.groupsByWorktree?.[workspace][0].tabOrder).toEqual([
      'agent-chat',
      'structured-agent-session-reserved-session'
    ])
    expect(launchReads).toBeGreaterThan(0)
  } finally {
    updateStructuredAgentLaunchRecords(records.map((record) => [record.sessionId, null]))
  }
})

beforeEach(() => {
  launches.states = []
  launches.reads = 0
  transport.callRuntimeRpc.mockReset()
  testStore.current = createTestStore()
  testStore.current.setState({ activeWorktreeId: workspace })
})

function launchState(index: number, worktreeId = workspace): StructuredLaunchState {
  const sessionId = `launch-${index}`
  return {
    intent: {
      worktreeId,
      executionHostId: 'local',
      target: { kind: 'local' },
      sessionId,
      agent: 'codex',
      params: {
        worktree: `id:${worktreeId}`,
        agent: 'codex',
        envelope: {
          sessionId,
          clientOperationId: sessionId,
          expectedRuntimeFence: null,
          payloadFingerprint: sessionId
        }
      }
    },
    identity: `codex:${worktreeId}`,
    promise: new Promise(() => {}),
    visibilityUnknown: false,
    cancelled: false,
    operationEnded: true,
    promptDelivery: undefined,
    selection: {},
    callers: {
      outcome: 'pending',
      attempt: { kind: 'first', requestId: sessionId, stagedPrompt: null },
      entries: new Set(),
      promptDeliveryResults: new Set(),
      onSettled: () => {}
    }
  }
}

it.each([100, 1_000])('bounds status scans for %i settled launches of one agent', (population) => {
  launches.states = Array.from({ length: population }, (_, index) => launchState(index))
  expect(hasStructuredAgentLaunchInWorktree(workspace)).toBe(false)
  expect(launches.reads).toBeLessThanOrEqual(2 * population)

  const pending = launchState(population)
  pending.intent.agent = 'claude'
  pending.intent.params.agent = 'claude'
  pending.identity = `claude:${workspace}`
  delete pending.operationEnded
  launches.states.push(pending)
  launches.reads = 0
  expect(hasStructuredAgentLaunchInWorktree(workspace)).toBe(true)
  expect(launches.reads).toBeLessThanOrEqual(3 * (population + 1))
})

it.each([100, 1_000])(
  'skips %i unrelated inventories when a chat already owns the surface',
  async (population) => {
    const store = testStore.current!
    let pendingReads = 0
    let editorReads = 0
    let persistedReads = 0
    const groupId = store.getState().ensureWorktreeRootGroup(workspace)
    launches.states = Array.from({ length: population }, (_, index) =>
      launchState(index, `repo1::/tmp/other-${index}`)
    )
    const pendingWorktreeCreations: Record<string, PendingWorktreeCreation> = Object.fromEntries(
      Array.from({ length: population }, (_, index) => [
        `pending-${index}`,
        {
          creationId: `pending-${index}`,
          worktreeId: `repo1::/tmp/other-${index}`,
          phase: 'creating',
          get status() {
            pendingReads++
            return 'creating' as const
          },
          startedAt: 1,
          indeterminate: false,
          loaderVisible: false,
          request: {
            repoId: 'repo1',
            name: `other-${index}`,
            setupDecision: 'skip',
            agent: null,
            pendingFirstAgentMessageRename: false,
            note: '',
            startupPlan: null,
            quickPrompt: '',
            quickTelemetry: null
          }
        }
      ])
    )
    const openFiles: OpenFile[] = Array.from({ length: population }, (_, index) => ({
      get id() {
        editorReads++
        return `/other/file-${index}.ts`
      },
      filePath: `/other/file-${index}.ts`,
      relativePath: `file-${index}.ts`,
      worktreeId: 'repo1::/tmp/other',
      language: 'typescript',
      mode: 'edit',
      isDirty: false
    }))
    const records: StructuredAgentLaunchPersistedRecord[] = Array.from(
      { length: population },
      (_, index) => ({
        sessionId: `record-${index}`,
        get executionHostId() {
          persistedReads++
          return 'local' as const
        },
        agent: 'codex',
        lifecycle: 'pending',
        clientOperationId: `record-${index}`,
        payloadFingerprint: 'fingerprint',
        expectedRuntimeFence: null,
        surfaceAddress: { worktreeId: workspace, targetGroupId: groupId, precedingTabIds: [] }
      })
    )
    updateStructuredAgentLaunchRecords(records.map((record) => [record.sessionId, record]))
    store.getState().createUnifiedTab(workspace, 'editor', { entityId: '/other/file-0.ts' })
    store.getState().createUnifiedTab(workspace, 'agent-session', {
      id: 'agent-chat',
      entityId: 'agent-session',
      agentSessionAgent: 'codex'
    })
    const group = store.getState().groupsByWorktree[workspace][0]
    store.setState({
      pendingWorktreeCreations,
      openFiles,
      groupsByWorktree: {
        [workspace]: [{ ...group, tabOrder: [...group.tabOrder, 'stale'] }]
      }
    })
    pendingReads = 0
    editorReads = 0
    persistedReads = 0
    launches.reads = 0
    const assertNoInventoryWork = (): void => {
      expect(pendingReads).toBe(0)
      expect(launches.reads).toBe(0)
      expect(editorReads).toBe(0)
      expect(persistedReads).toBe(0)
      expect(store.getState().tabsByWorktree[workspace] ?? []).toEqual([])
    }
    try {
      await createInitialTerminalSeeder(`chat-host-${population}`, workspace).seed()
      assertNoInventoryWork()
      for (const refused of [false, true]) {
        const reply = Promise.withResolvers<LayoutApplyReply>()
        transport.callRuntimeRpc.mockReturnValueOnce(reply.promise)
        expect(
          createInitialTerminalThroughLayoutOwner(store.getState, workspace, () => {
            store.getState().createTab(workspace)
          })
        ).toBe(true)
        if (refused) {
          reply.resolve({ ok: false, code: 'host_not_owned', frameSeq: 0 })
        } else {
          reply.reject(new Error('Host write rolled back'))
        }
        await reply.promise.catch(() => {})
        assertNoInventoryWork()
      }
    } finally {
      updateStructuredAgentLaunchRecords(records.map((record) => [record.sessionId, null]))
    }
  }
)

it.each([750, 7_500])('skips %i unrelated editors without an editor surface', (population) => {
  const store = testStore.current!
  let editorReads = 0
  const openFiles: OpenFile[] = Array.from({ length: population }, (_, index) => ({
    get id() {
      editorReads++
      return `/other/file-${index}.ts`
    },
    filePath: `/other/file-${index}.ts`,
    relativePath: `file-${index}.ts`,
    worktreeId: 'repo1::/tmp/other',
    language: 'typescript',
    mode: 'edit',
    isDirty: false
  }))
  const empty = projectWorktreeTabModelReconciliation({ ...store.getState(), openFiles }, workspace)
  expect(empty.renderableTabCount).toBe(0)
  expect(editorReads).toBe(0)

  store.getState().createUnifiedTab(workspace, 'agent-session', {
    id: 'agent-chat',
    entityId: 'agent-session',
    agentSessionAgent: 'codex'
  })
  const chat = projectWorktreeTabModelReconciliation({ ...store.getState(), openFiles }, workspace)
  expect(chat.renderableTabCount).toBe(1)
  expect(editorReads).toBe(0)

  store.getState().createUnifiedTab(workspace, 'editor', { entityId: '/other/file-0.ts' })
  const editor = projectWorktreeTabModelReconciliation(
    { ...store.getState(), openFiles },
    workspace
  )
  expect(editor.renderableTabCount).toBe(2)
  expect(editorReads).toBeGreaterThan(0)
})

it.each([100, 1_000])(
  'skips %i pending creations while a surface is claimed',
  async (population) => {
    const store = testStore.current!
    let pendingReads = 0
    const pendingWorktreeCreations = Object.fromEntries(
      Array.from({ length: population }, (_, index) => {
        const pending: PendingWorktreeCreation = {
          creationId: `pending-${index}`,
          worktreeId: `repo1::/tmp/other-${index}`,
          phase: 'creating',
          get status() {
            pendingReads++
            return 'creating' as const
          },
          startedAt: 1,
          indeterminate: false,
          loaderVisible: false,
          request: {
            repoId: 'repo1',
            name: `other-${index}`,
            setupDecision: 'skip',
            agent: null,
            pendingFirstAgentMessageRename: false,
            note: '',
            startupPlan: null,
            quickPrompt: '',
            quickTelemetry: null
          }
        }
        return [pending.creationId, pending]
      })
    )
    store.setState({ pendingWorktreeCreations })
    pendingReads = 0
    const seeder = createInitialTerminalSeeder(`claim-host-${population}`, workspace)
    const release = holdEmptyWorkspaceDefaultSurfaceForLaunch(workspace)
    try {
      await seeder.seed()
      expect(pendingReads).toBe(0)
      expect(store.getState().tabsByWorktree[workspace] ?? []).toEqual([])
    } finally {
      release()
    }
    await seeder.seed()
    expect(pendingReads).toBeGreaterThan(0)
    expect(store.getState().tabsByWorktree[workspace]).toHaveLength(1)
  }
)
