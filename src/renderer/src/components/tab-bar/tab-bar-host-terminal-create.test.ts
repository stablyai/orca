import { beforeEach, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { createTerminalTabOnHost } from './tab-bar-host-terminal-create'

const mocks = vi.hoisted(
  (): { call: ReturnType<typeof vi.fn>; store: null | ReturnType<typeof createTestStore> } => ({
    call: vi.fn(),
    store: null
  })
)
vi.mock('../../store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
createStoreCascadesMockApi()
const LOCAL = 'repo1::/local'
const HOST = 'remote::/host'
const REQUEST = {
  worktreeId: LOCAL,
  executionHostId: 'runtime:env-1',
  projectHostSetupId: 'remote-setup',
  agent: 'codex'
} as const
beforeEach(() => {
  mocks.call.mockReset()
})

it('creates a real host tab with native caller navigation and refuses missing host workspaces', async () => {
  const store = createTestStore()
  mocks.store = store
  const repos = [
    { ...TEST_REPO, id: 'repo1', path: '/local', executionHostId: 'local' as const },
    { ...TEST_REPO, id: 'remote', path: '/host', executionHostId: 'runtime:env-1' as const }
  ]
  const setupFields = {
    projectId: 'project',
    displayName: 'Project',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 0,
    updatedAt: 0
  } as const
  seedStore(store, {
    repos,
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: LOCAL,
          repoId: 'repo1',
          path: '/local',
          hostId: 'local',
          projectId: 'project'
        })
      ],
      remote: [makeWorktree({ id: HOST, repoId: 'remote', path: '/host', hostId: 'runtime:env-1' })]
    },
    projects: [
      {
        id: 'project',
        displayName: 'Project',
        badgeColor: '',
        sourceRepoIds: ['repo1', 'remote'],
        createdAt: 0,
        updatedAt: 0
      }
    ],
    projectHostSetups: [
      { ...setupFields, id: 'local-setup', repoId: 'repo1', hostId: 'local', path: '/local' },
      {
        ...setupFields,
        id: 'remote-setup',
        repoId: 'remote',
        hostId: 'runtime:env-1',
        path: '/host'
      }
    ]
  })
  const leafId = '11111111-1111-4111-8111-111111111111'
  mocks.call.mockResolvedValue({
    tab: {
      id: 'host-tab',
      parentTabId: 'host-tab',
      leafId,
      terminal: 'host-handle',
      title: 'Host terminal'
    }
  })
  expect(await createTerminalTabOnHost(REQUEST)).toMatchObject({
    hostWorktreeId: HOST,
    tabId: 'host-tab',
    leafId,
    handle: 'host-handle'
  })
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'env-1' },
    'session.tabs.createTerminal',
    {
      worktree: `id:${HOST}`,
      activate: false,
      select: true,
      navigation: 'caller',
      clientMutationId: expect.any(String),
      agent: 'codex'
    },
    { timeoutMs: 15_000 }
  )
  expect(store.getState().tabsByWorktree[LOCAL] ?? []).toEqual([])
  store.setState({ worktreesByRepo: { repo1: store.getState().worktreesByRepo.repo1 } })
  await expect(createTerminalTabOnHost(REQUEST)).rejects.toThrow('selector_not_found')
  expect(mocks.call).toHaveBeenCalledTimes(1)
})
