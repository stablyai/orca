import { isUnifiedTabOwnedByWorktree } from '@/lib/unified-tab-host-ownership'
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn().mockResolvedValue(undefined)
}))
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
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
createStoreCascadesMockApi()
const LOCAL = 'repo1::/local'
const HOST = 'native-repo::/host/native'
const REQUEST = {
  worktreeId: LOCAL,
  executionHostId: 'runtime:env-1',
  projectHostSetupId: 'remote-setup'
} as const
beforeEach(() => {
  mocks.call.mockReset()
})

it('creates and shows a host catalog tab with caller navigation without viewer host workspaces', async () => {
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
      remote: [
        makeWorktree({
          id: 'remote::/host',
          repoId: 'remote',
          path: '/host',
          hostId: 'runtime:env-1'
        })
      ]
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
  const created = {
    tab: {
      id: 'host-tab',
      parentTabId: 'host-tab',
      leafId,
      terminal: 'host-handle',
      title: 'Host terminal'
    }
  }
  mocks.call.mockImplementation((_target, method) => {
    switch (method) {
      case 'projectHostSetup.list':
        return {
          setups: [
            {
              ...setupFields,
              id: 'remote-setup',
              repoId: 'native-repo',
              hostId: 'local',
              path: '/host/native'
            }
          ]
        }
      case 'worktree.ps':
        return {
          worktrees: [{ worktreeId: HOST, repoId: 'native-repo', hostId: 'local', isActive: true }]
        }
      case 'folderWorkspace.list':
        return { folderWorkspaces: [] }
      case 'worktree.show':
        return { worktree: { id: HOST } }
      case 'session.tabs.activate':
        return {}
      case 'session.tabs.createTerminal':
        return created
      default:
        throw new Error(`Unexpected method: ${method}`)
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
      activate: true,
      select: true,
      navigation: 'caller',
      clientMutationId: expect.any(String)
    },
    { timeoutMs: 15_000 }
  )
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'env-1' },
    'session.tabs.activate',
    { worktree: `id:${HOST}`, tabId: 'host-tab', leafId, navigation: 'host' }
  )
  expect(store.getState().tabsByWorktree[LOCAL]).toMatchObject([
    {
      id: 'web-terminal-host-tab',
      ptyId: null,
      hostTerminalAlias: {
        tabId: 'host-tab',
        leafId,
        executionHostId: 'runtime:env-1',
        worktreeId: HOST
      }
    }
  ])
  store.setState({ worktreesByRepo: { repo1: store.getState().worktreesByRepo.repo1 } })
  await expect(createTerminalTabOnHost(REQUEST)).resolves.toMatchObject({ hostWorktreeId: HOST })
  expect(mocks.call).toHaveBeenCalledTimes(12)
  const source = store.getState().worktreesByRepo.repo1![0]!
  const aliasEntry = store.getState().unifiedTabsByWorktree[LOCAL]![0]!
  expect(isUnifiedTabOwnedByWorktree(aliasEntry, source, new Set())).toBe(true)
  store.setState({
    worktreesByRepo: {
      repo1: [{ ...source, hostId: 'local', runtimeOwnerEnvironmentId: 'other-runtime' }]
    }
  })
  await expect(createTerminalTabOnHost(REQUEST)).rejects.toThrow('source_worktree_not_local')
  expect(mocks.call).toHaveBeenCalledTimes(12)
})
