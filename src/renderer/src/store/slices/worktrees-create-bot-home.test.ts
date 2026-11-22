import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { toast } from 'sonner'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../shared/bot-types'
import { resolveWorktreeCreateParent } from './worktrees/create/worktree-create-parent-pick'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees/worktrees-slice-test-harness'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock(
  '@/components/sidebar/workspace-creation/base-ref-update/worktree-base-fallback-notice',
  () => ({
    requestWorktreeBaseFallbackNotice: vi.fn()
  })
)

beforeEach(resetWorktreeSliceModuleMemory)

describe('createWorktree from a bot home', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  function createParentPickStore(parent?: Worktree) {
    const store = createRepoTestStore()
    store.setState({
      repos:
        parent && parent.repoId !== TEST_REPO.id
          ? [TEST_REPO, { ...TEST_REPO, id: parent.repoId }]
          : [TEST_REPO],
      worktreesByRepo: parent ? { [parent.repoId]: [parent] } : {}
    })
    return store
  }

  it("doesn't attach a new workspace to an open bot's home", async () => {
    publishBots([makeBot()])
    try {
      const store = createParentPickStore()
      store.setState({
        activeWorkspaceKey: folderWorkspaceKey('bot-home'),
        folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home' })]
      })
      mockApi.worktrees.create.mockResolvedValue({
        worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1', path: '/path/child' })
      })

      await store.getState().createWorktree('repo1', 'feature', 'origin/main')

      expect(mockApi.worktrees.create.mock.calls[0]?.[0]).not.toHaveProperty('parentWorkspace')
      expect(toast.warning).not.toHaveBeenCalled()
    } finally {
      publishBots([])
    }
  })

  it("doesn't attach a new workspace to an open home on another machine", () => {
    const botHost: ExecutionHostId = 'runtime:air'
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: botHost, state: 'live' }
      ],
      updateNeeded: []
    })
    publishBots([makeBot()], undefined, botHost)
    try {
      const store = createParentPickStore()
      store.setState({
        activeWorkspaceKey: folderWorkspaceKey('bot-home'),
        activeWorkspaceExecutionHostId: botHost,
        folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home', executionHostId: botHost })]
      })

      const parent = resolveWorktreeCreateParent(store.getState(), undefined, 'local')

      expect(parent.parentWorkspace).toBeUndefined()
      expect(parent.crossStoreParentRow).toBeUndefined()
    } finally {
      publishBots([], undefined, botHost)
      setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
    }
  })

  it("doesn't attach a new workspace to an open home whose folder record isn't loaded yet", () => {
    publishBots([makeBot()])
    try {
      const store = createParentPickStore()
      store.setState({
        activeWorkspaceKey: folderWorkspaceKey('bot-home'),
        activeWorkspaceExecutionHostId: 'local',
        folderWorkspaces: []
      })

      const parent = resolveWorktreeCreateParent(store.getState(), undefined, 'local')

      expect(parent.parentWorkspace).toBeUndefined()
      expect(parent.crossStoreParentRow).toBeUndefined()
    } finally {
      publishBots([])
    }
  })

  it("doesn't attach a new workspace to an open home on an unknown host before its record loads", () => {
    const botHost: ExecutionHostId = 'runtime:air'
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: botHost, state: 'live' }
      ],
      updateNeeded: []
    })
    publishBots([makeBot()], undefined, botHost)
    try {
      const store = createParentPickStore()
      store.setState({
        activeWorkspaceKey: folderWorkspaceKey('bot-home'),
        activeWorkspaceExecutionHostId: null,
        folderWorkspaces: []
      })

      const parent = resolveWorktreeCreateParent(store.getState(), undefined, 'local')

      expect(parent.parentWorkspace).toBeUndefined()
      expect(parent.crossStoreParentRow).toBeUndefined()
    } finally {
      publishBots([], undefined, botHost)
      setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
    }
  })

  // Owner decision: a task id typed in the note is deliberate attribution, so it still names the
  // parent while a bot's page is open; only the open home itself is never the fallback parent.
  // Also the only check of the home guard for a local home with a server repo.
  it("lets a note's task id name the parent while this computer's bot home is open", async () => {
    publishBots([makeBot()])
    // The note's inference reads the server's identity through an abortable subscription.
    const status = createCompatibleRuntimeStatusResponse()
    const serverStatus = {
      ...status,
      result: { ...status.result, hostDescriptor: { installationId: 'server-install' } }
    }
    const runtimeEnvironments = Object.assign(mockApi.runtimeEnvironments, {
      subscribe: vi.fn(
        async (
          _request: RuntimeEnvironmentCallRequest,
          handlers: { onResponse: (response: unknown) => void }
        ) => {
          queueMicrotask(() => handlers.onResponse(serverStatus))
          return { unsubscribe: () => undefined }
        }
      ),
      cancelSubscription: vi.fn(async () => undefined)
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'create',
      ok: true,
      result: { worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1' }) },
      _meta: { runtimeId: 'remote-runtime' }
    })
    mockApi.runtime.call.mockResolvedValueOnce({
      id: 'resolve',
      ok: true,
      result: {
        parent: {
          installationId: 'desktop-install',
          workspaceKey: 'worktree:repo2::/path/task-parent',
          instanceId: 'instance-1'
        },
        source: 'orchestration-context'
      }
    })
    try {
      const store = createParentPickStore()
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
        activeWorkspaceKey: folderWorkspaceKey('bot-home'),
        activeWorkspaceExecutionHostId: 'local',
        folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home', executionHostId: 'local' })]
      })
      const createWorktree = store.getState().createWorktree
      const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
      args[25] = { executionHostId: 'runtime:env-1', note: 'Follow-up for task_abc123' }

      await createWorktree(...args)

      const create = runtimeEnvironmentCall.mock.calls.find(
        ([call]) => call.method === 'worktree.create'
      )
      expect(create?.[0].params).toMatchObject({
        crossStoreParent: {
          installationId: 'desktop-install',
          workspaceKey: 'worktree:repo2::/path/task-parent',
          instanceId: 'instance-1'
        },
        crossStoreParentInferredFrom: 'orchestration-context'
      })
      expect(runtimeEnvironments.subscribe).toHaveBeenCalled()
      expect(toast.warning).not.toHaveBeenCalled()
    } finally {
      publishBots([])
      Reflect.deleteProperty(runtimeEnvironments, 'subscribe')
      Reflect.deleteProperty(runtimeEnvironments, 'cancelSubscription')
      // A failure before inference would leave the queued answer for a later test.
      mockApi.runtime.call.mockReset()
      mockApi.runtime.call.mockResolvedValue({
        id: 'runtime-call',
        ok: true,
        result: { stoppedWorktreeIds: [] }
      })
    }
  })
})

function makeBot(): Bot {
  return {
    id: 'bot-1',
    name: 'Ranger',
    hostId: 'local',
    folder: 'ranger',
    folderWorkspaceId: 'bot-home',
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function seedRepoHost(store: ReturnType<typeof createTestStore>, hostId: ExecutionHostId): void {
  store.setState({ repos: [{ ...TEST_REPO, executionHostId: hostId }] })
}

function createRepoTestStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedRepoHost(store, 'local')
  return store
}
