import { beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '../../../store/slices/tabs/tabs-slice-test-harness'
import { projectWorktreeTabModelReconciliation } from '../../../store/slices/tabs/tabs-reconciliation'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { updateStructuredAgentLaunchRecords } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import type { StructuredAgentLaunchPersistedRecord } from '@/lib/agent-session/launch/structured-agent-session-launch-record'
import { holdEmptyWorkspaceDefaultSurfaceForLaunch } from '@/lib/workspace/activation/initial-surface/empty-workspace-default-surface-claims'

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
  testStore.current = createTestStore()
  testStore.current.setState({ activeWorktreeId: workspace })
})

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
          request: { repoId: 'repo1', name: `other-${index}`, setupDecision: 'skip', agent: null }
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
