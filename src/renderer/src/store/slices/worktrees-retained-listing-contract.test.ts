import { beforeEach, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs/promises'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../../main/persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../../../shared/constants'
import { storeWorktreeMeta } from '../../../../main/runtime/runtime-store-partial-fixture'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'
const { rawScan, gitRead } = vi.hoisted(() => ({ rawScan: vi.fn(), gitRead: vi.fn() }))
vi.mock('../../../../main/repo-worktrees', () => ({ listRepoWorktreesForDetectedScan: rawScan }))
vi.mock('../../../../main/git/runner', () => ({
  gitExecFileAsync: gitRead,
  translateWslOutputPaths: (text: string) => text
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Fs>()),
  stat: async () => ({ isDirectory: () => true }),
  realpath: async (path: string) => path
}))
vi.mock('../../../../main/ipc/registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 0,
  registerWorktreeRootsForRepo: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
import { listDetectedWorktreesForCapturedRepo } from '../../../../main/ipc/worktrees/listing/detected-provider-listing'
import {
  __resetDetectedWorktreeScanCacheForTests,
  invalidateDetectedWorktreeScanCache
} from '../../../../main/ipc/worktrees/listing/detected-worktree-scan-cache'

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  __resetDetectedWorktreeScanCacheForTests()
  vi.clearAllMocks()
})
it('preserves review metadata through a failed production listing and merge, then applies observed recovery and genuine detach', async () => {
  const repo: Repo = {
    id: 'repo1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const id = 'repo1::/feature'
  const old = makeWorktree({
    id,
    repoId: repo.id,
    path: '/feature',
    branch: 'refs/heads/feature',
    linkedPR: 101,
    pushTarget: { remoteName: 'origin', branchName: 'feature' }
  })
  const meta: Record<string, WorktreeMeta> = {
    [id]: storeWorktreeMeta({ ...old, hostId: 'local', instanceId: 'saved' })
  }
  const host: Store = Object.create(null)
  Object.assign(host, {
    getRepos: () => [repo],
    getRepo: () => repo,
    getProjects: () => [],
    getProjectHostSetups: () => [],
    getWorkspaceSession: () => ({ ...getDefaultWorkspaceSession(), tabsByWorktree: { [id]: [] } }),
    getSettings: () => getDefaultSettings('/fixture'),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    getWorktreeMetaForHost: (id: string) => meta[id],
    setWorktreeMeta: vi.fn(({ id }, updates) => storeWorktreeMeta({ ...meta[id], ...updates })),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined
  } satisfies Partial<Store>)
  const renderer = createTestStore()
  renderer.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [old] } })
  mockApi.worktrees.listDetected.mockImplementation(async () => {
    const result = await listDetectedWorktreesForCapturedRepo(host, repo, () => true)
    if (!result || !('worktrees' in result)) {
      throw new Error('missing listing')
    }
    return result
  })
  const rawMain = {
    path: repo.path,
    head: 'a'.repeat(40),
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  }
  rawScan.mockResolvedValue([rawMain])
  gitRead.mockRejectedValue(new Error('checkout unavailable'))
  await renderer.getState().fetchWorktrees(repo.id)
  expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([old])
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  // Recovery reuses the raw scan without turning a failed checkout read into a detached observation.
  gitRead.mockImplementation(async (args: string[]) => ({
    stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : 'refs/heads/feature',
    stderr: ''
  }))
  await renderer.getState().fetchWorktrees(repo.id)
  expect(renderer.getState().worktreesByRepo[repo.id]?.find((row) => row.id === id)).toMatchObject({
    branch: 'refs/heads/feature',
    linkedPR: 101
  })
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  invalidateDetectedWorktreeScanCache(repo.id)
  rawScan.mockResolvedValue([
    rawMain,
    { ...rawMain, path: '/feature', isMainWorktree: false, branch: '' }
  ])
  await renderer.getState().fetchWorktrees(repo.id)
  expect(renderer.getState().worktreesByRepo[repo.id]?.find((row) => row.id === id)).toMatchObject({
    branch: '',
    linkedPR: null,
    pushTarget: undefined
  })
  expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
    expect.objectContaining({
      worktreeId: id,
      updates: expect.objectContaining({ linkedPR: null })
    })
  )
})
