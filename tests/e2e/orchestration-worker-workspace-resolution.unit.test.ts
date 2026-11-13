import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RepoWorktreeResolutionScan from '../../src/main/runtime/workspaces/catalog/repo-worktree-resolution-scan'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const scanLocalRepoWorktreesForResolution = vi.hoisted(() => vi.fn())
vi.mock(
  '../../src/main/runtime/workspaces/catalog/repo-worktree-resolution-scan',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RepoWorktreeResolutionScan>()),
    scanLocalRepoWorktreesForResolution
  })
)

import '../../src/main/runtime/orchestration/db/contract-constants'
import '../../src/main/runtime/orchestration/db/messages/mailbox-routing-page'
import '../../src/main/runtime/orchestration/db/dispatch-row-writer'
import '../../src/main/runtime/orchestration/db/attempt-outcome-projection'

import type { FolderWorkspace } from '../../src/shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../src/shared/project-group-types'
import type { Repo } from '../../src/shared/repo-types'
import type { WorktreeMeta } from '../../src/shared/worktree/meta-types'
import type { RuntimeStore } from '../../src/main/runtime/construction/runtime-store-contract'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type { HostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'

const REPO_ID = 'repo-1'
const REPO_PATH = '/repo'
const WORKTREE_PATH = '/repo/feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

function makeMeta(displayName: string, hostId?: WorktreeMeta['hostId']): WorktreeMeta {
  return {
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(hostId ? { hostId } : {})
  }
}

function makeStore(
  options: {
    repos?: Repo[]
    meta?: Record<string, WorktreeMeta>
    folderWorkspaces?: FolderWorkspace[]
    projectGroups?: ProjectGroup[]
  } = {}
) {
  const repos = options.repos ?? [
    {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'App',
      badgeColor: 'blue',
      addedAt: 1
    }
  ]
  const meta = options.meta ?? { [WORKTREE_ID]: makeMeta('Feature') }
  const store = {
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => {
      meta[id] = { ...(meta[id] ?? makeMeta('')), ...patch }
      return meta[id]
    },
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none' as const,
      branchPrefixCustom: ''
    }),
    getProjects: () => [],
    getFolderWorkspaces: () => options.folderWorkspaces ?? [],
    getProjectGroups: () => options.projectGroups ?? []
  }
  return store satisfies RuntimeStore
}

describe('orchestration worker workspace resolution', () => {
  beforeEach(() => {
    scanLocalRepoWorktreesForResolution.mockReset().mockResolvedValue({
      ok: true,
      worktrees: [
        {
          path: WORKTREE_PATH,
          head: 'abc',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]
    })
  })

  it('preserves a disconnected SSH worktree with unknown legacy ownership', async () => {
    const remoteRepo = {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'Remote app',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    } satisfies Repo
    const runtime = new OrcaRuntimeService(
      makeStore({
        repos: [remoteRepo],
        meta: { [WORKTREE_ID]: makeMeta('Remote feature') }
      }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      id: WORKTREE_ID,
      hostId: 'ssh:ssh-1'
    })
  })

  it('never infers a disconnected owner for unstamped same-id host twins', async () => {
    const repo: Repo = {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'Remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const runtime = new OrcaRuntimeService(
      makeStore({
        repos: [repo, { ...repo, connectionId: 'ssh-2' }],
        meta: { [WORKTREE_ID]: makeMeta('Remote feature') }
      })
    )
    await expect(runtime.showManagedTerminalWorkspace(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('rejects an ambiguous worktree name', async () => {
    const secondPath = '/repo/other'
    scanLocalRepoWorktreesForResolution.mockResolvedValue({
      ok: true,
      worktrees: [
        { path: WORKTREE_PATH, head: 'a', branch: 'one', isBare: false, isMainWorktree: false },
        { path: secondPath, head: 'b', branch: 'two', isBare: false, isMainWorktree: false }
      ]
    })
    const runtime = new OrcaRuntimeService(
      makeStore({
        meta: {
          [WORKTREE_ID]: makeMeta('Duplicate'),
          [`${REPO_ID}::${secondPath}`]: makeMeta('Duplicate')
        }
      }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace('name:Duplicate')).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  it('rejects the same worktree path on different execution hosts', async () => {
    const remoteRepo = {
      id: 'repo-remote',
      path: '/remote-repo',
      displayName: 'Remote app',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    } satisfies Repo
    const runtime = new OrcaRuntimeService(
      makeStore({
        repos: [makeStore().getRepos()[0], remoteRepo],
        meta: {
          [WORKTREE_ID]: makeMeta('Local feature'),
          [`${remoteRepo.id}::${WORKTREE_PATH}`]: makeMeta('Remote feature')
        }
      }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace(`path:${WORKTREE_PATH}`)).rejects.toThrow(
      'selector_ambiguous'
    )
  })
})
