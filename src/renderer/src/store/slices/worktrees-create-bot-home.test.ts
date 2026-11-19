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
  resetWorktreeSliceModuleMemory
} from './worktrees/worktrees-slice-test-harness'

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
