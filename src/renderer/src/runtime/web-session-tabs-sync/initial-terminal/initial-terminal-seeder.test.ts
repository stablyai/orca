import { beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '../../../store/slices/tabs/tabs-slice-test-harness'
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

beforeEach(() => {
  testStore.current = createTestStore()
  testStore.current.setState({ activeWorktreeId: workspace })
})

it('keeps a provisional chat as the only surface after an empty host answer', async () => {
  const store = testStore.current!
  const seeder = createInitialTerminalSeeder('paired-host', workspace)
  expect(
    seeder.decide(
      {
        type: 'snapshot',
        worktree: workspace,
        publicationEpoch: 'host-epoch',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        tabs: []
      },
      true
    )
  ).toBe(true)

  const release = holdEmptyWorkspaceDefaultSurfaceForLaunch(workspace)
  try {
    await seeder.seed()
    expect(store.getState().tabsByWorktree[workspace] ?? []).toEqual([])
  } finally {
    release()
  }

  store.getState().createUnifiedTab(workspace, 'agent-session', {
    id: 'agent-chat',
    entityId: 'agent-session',
    agentSessionAgent: 'codex'
  })
  await seeder.seed()

  expect(store.getState().tabsByWorktree[workspace] ?? []).toEqual([])
  expect(
    store.getState().unifiedTabsByWorktree[workspace]?.map((tab) => ({
      id: tab.id,
      contentType: tab.contentType
    }))
  ).toEqual([{ id: 'agent-chat', contentType: 'agent-session' }])
})

it('seeds a terminal-only workspace after its launch claim is released', async () => {
  const seeder = createInitialTerminalSeeder('terminal-only-host', workspace)
  const release = holdEmptyWorkspaceDefaultSurfaceForLaunch(workspace)
  try {
    await seeder.seed()
    expect(testStore.current!.getState().tabsByWorktree[workspace] ?? []).toEqual([])
  } finally {
    release()
  }

  await seeder.seed()
  expect(testStore.current!.getState().tabsByWorktree[workspace]).toHaveLength(1)
})

it('leaves the first surface to an agent launch reported by the host', async () => {
  const seeder = createInitialTerminalSeeder('launching-host', workspace)
  if (
    seeder.decide(
      {
        type: 'snapshot',
        worktree: workspace,
        publicationEpoch: 'host-epoch',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        initialSurfaceLaunch: { launchId: 'host-launch', agent: 'codex' },
        tabs: []
      },
      true
    )
  ) {
    await seeder.seed()
  }
  expect(testStore.current!.getState().tabsByWorktree[workspace] ?? []).toEqual([])
})
