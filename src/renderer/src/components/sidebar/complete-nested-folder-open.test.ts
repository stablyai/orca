import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import { completeNestedFolderOpen } from './complete-nested-folder-open'

const mocks = vi.hoisted(() => ({
  addRepoPath: vi.fn(),
  addNonGitFolder: vi.fn(),
  clearOrcaHookTrustForRepo: vi.fn(),
  openModal: vi.fn(),
  addRemote: vi.fn(),
  upsert: vi.fn(),
  track: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks } }))
vi.mock('./add-repo-store-upsert', () => ({ upsertAddedRepoWithProjectHostSetup: mocks.upsert }))
vi.mock('./track-nested-folder-open', () => ({ trackNestedFolderOpen: mocks.track }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const repo: Repo = {
  id: 'repo',
  path: '/host/repo',
  displayName: 'repo',
  badgeColor: '',
  kind: 'git',
  addedAt: 1
}
const scan: NestedRepoScanResult = {
  selectedPath: repo.path,
  selectedPathKind: 'git_repo',
  repos: [],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 1,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}

function args() {
  return {
    scan,
    generation: 1,
    currentGeneration: () => 1,
    attemptId: 'attempt',
    runtimeKind: 'local' as const,
    connectionId: null,
    selectedCount: 0,
    getRuntimeKind: () => 'local' as const,
    owner: null,
    closeModal: vi.fn(),
    setIsAdding: vi.fn(),
    fetchWorktrees: vi.fn().mockResolvedValue(true),
    onGitRepoReady: vi.fn().mockResolvedValue(undefined)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.addRepoPath.mockResolvedValue(repo)
  mocks.addRemote.mockResolvedValue({ repo })
  mocks.upsert.mockReturnValue({ repo, alreadyPresent: true })
  vi.stubGlobal('window', { api: { repos: { addRemote: mocks.addRemote } } })
})

describe('open project after group-import explanation', () => {
  it.each([null, 'paired-host'])('keeps local/runtime owner %s', async (owner) => {
    const input = { ...args(), owner }
    await completeNestedFolderOpen(input)
    expect(mocks.addRepoPath).toHaveBeenCalledWith(repo.path, 'git', {
      runtimeEnvironmentId: owner
    })
    expect(input.onGitRepoReady).toHaveBeenCalledWith(
      repo.id,
      owner ? 'runtime_server_path' : 'local_folder_picker',
      owner ? 'runtime:paired-host' : 'local'
    )
    expect(mocks.addNonGitFolder).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('preserves SSH target and resets cached hook trust for existing projects', async () => {
    const input = { ...args(), connectionId: 'ssh-host' }
    await completeNestedFolderOpen(input)
    expect(mocks.addRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-host',
      remotePath: repo.path
    })
    expect(mocks.clearOrcaHookTrustForRepo).toHaveBeenCalledWith(repo.id)
    expect(input.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'ssh_remote_path', 'ssh:ssh-host')
  })

  it('does not navigate after generation changes while refreshing', async () => {
    let generation = 1
    const input = { ...args(), currentGeneration: () => generation }
    input.fetchWorktrees.mockImplementation(async () => {
      generation++
      return true
    })
    await completeNestedFolderOpen(input)
    expect(input.onGitRepoReady).not.toHaveBeenCalled()
  })
})
