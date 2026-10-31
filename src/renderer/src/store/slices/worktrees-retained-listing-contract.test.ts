import type { Tab } from '../../../../shared/tab-types'
import { parseWorktreeList } from '../../../../shared/git-worktree-porcelain-parser'
import { buildWorkspaceSessionPatch } from '../../lib/workspace-session-patch'
import { beforeEach, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs/promises'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../../main/persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../../../shared/constants'
import { storeWorktreeMeta } from '../../../../main/runtime/runtime-store-partial-fixture'
import { makeTerminalTab, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'
const { rawScan, gitRead, physicalPath } = vi.hoisted(() => ({
  rawScan: vi.fn(),
  gitRead: vi.fn(),
  physicalPath: vi.fn(async (path: string) => path)
}))
vi.mock('../../../../main/repo-worktrees', () => ({ listRepoWorktreesForDetectedScan: rawScan }))
vi.mock('../../../../main/git/runner', () => ({
  gitExecFileAsync: gitRead,
  translateWslOutputPaths: (text: string) => text
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Fs>()),
  stat: async () => ({ isDirectory: () => true }),
  realpath: physicalPath
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
  physicalPath.mockImplementation(async (path) => path)
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
  for (const failure of [
    Object.assign(new Error('cd: checkout unavailable'), {
      code: 1,
      stderr: 'cd: no such directory'
    }),
    Object.assign(new Error('shell exited before Git'), { code: 1, stderr: '' }),
    '',
    'refs/heads/',
    'refs/heads/bad..ref',
    'HEAD\nrefs/heads/feature',
    ' refs/heads/feature',
    'refs/remotes/origin/feature'
  ]) {
    gitRead.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-prefix')) {
        return { stdout: `\n${'a'.repeat(40)}\n`, stderr: '' }
      }
      if (failure instanceof Error) {
        throw failure
      }
      return { stdout: failure, stderr: '' }
    })
    await renderer.getState().fetchWorktrees(repo.id)
    expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([old])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  }
  for (const stdout of [
    '',
    'bad-head',
    `\n${'a'.repeat(40)}\ntrailing`,
    `nested/\n${'a'.repeat(40)}\n`
  ]) {
    gitRead.mockResolvedValue({ stdout, stderr: '' })
    await renderer.getState().fetchWorktrees(repo.id)
    expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([old])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  }
  // A successful porcelain prefix has no detached token: alias and prunable reuse must enrich or fail.
  for (const alias of [true, false]) {
    physicalPath.mockImplementation(async (path) => (path === '/feature' ? '/raw-feature' : path))
    const incomplete = parseWorktreeList(
      `worktree ${alias ? '/raw-feature' : '/feature'}\0HEAD ${'a'.repeat(40)}\0`,
      { nulDelimited: true }
    )[0]!
    rawScan.mockResolvedValue([rawMain, { ...incomplete, isMainWorktree: false, prunable: !alias }])
    invalidateDetectedWorktreeScanCache(repo.id)
    gitRead.mockRejectedValue(new Error('unknown branch'))
    await renderer.getState().fetchWorktrees(repo.id)
    expect(renderer.getState().worktreesByRepo[repo.id]).toEqual([old])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  }
  rawScan.mockResolvedValue([rawMain])
  invalidateDetectedWorktreeScanCache(repo.id)
  // Recovery reuses the raw scan without turning a failed checkout read into a detached observation.
  gitRead.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('--show-prefix') ? `\n${'a'.repeat(40)}\n` : 'refs/heads/feature',
    stderr: ''
  }))
  await renderer.getState().fetchWorktrees(repo.id)
  expect(renderer.getState().worktreesByRepo[repo.id]?.find((row) => row.id === id)).toMatchObject({
    branch: 'refs/heads/feature',
    linkedPR: 101
  })
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  invalidateDetectedWorktreeScanCache(repo.id)
  gitRead.mockImplementation(async (args: string[]) => ({
    stdout: args.includes('--show-prefix') ? `\n${'a'.repeat(40)}\n` : 'HEAD\n',
    stderr: ''
  }))
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

it('preserves saved alias rows through authoritative purge, layout and session persistence, suppressing only unowned discoveries', async () => {
  const repo: Repo = {
    id: 'repo1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const oid = 'a'.repeat(40)
  const raw = parseWorktreeList(
    `worktree /repo\0HEAD ${oid}\0branch refs/heads/main\0\0worktree /raw\0HEAD ${oid}\0branch refs/heads/feature\0\0`,
    { nulDelimited: true }
  )
  physicalPath.mockImplementation(async (path) => (path.startsWith('/alias') ? '/raw' : path))
  for (const saved of [
    ['/alias1'],
    ['/raw', '/alias1'],
    ['/alias1', '/alias2'],
    ['/raw', '/alias1', '/alias2']
  ]) {
    for (const sessions of [saved, [saved[0]!], []]) {
      resetWorktreeSliceModuleMemory()
      __resetDetectedWorktreeScanCacheForTests()
      const meta = Object.fromEntries(
        saved.map((path) => [
          `repo1::${path}`,
          storeWorktreeMeta({
            hostId: 'local',
            displayName: path,
            linkedPR: 42,
            pushTarget: { remoteName: 'origin', branchName: 'feature' }
          })
        ])
      )
      const session = {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: Object.fromEntries(sessions.map((path) => [`repo1::${path}`, []]))
      }
      const host: Store = Object.create(null)
      Object.assign(host, {
        getRepos: () => [repo],
        getRepo: () => repo,
        getProjects: () => [],
        getProjectHostSetups: () => [],
        getWorkspaceSession: () => session,
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
      const tabs = Object.fromEntries(
        sessions.map((path, i) => [
          `repo1::${path}`,
          [makeTerminalTab({ id: `t${i}`, worktreeId: `repo1::${path}`, title: 'Terminal' })]
        ])
      )
      renderer.setState({
        lastKnownRelayPtyIdByTabId: {},
        browserPagesByWorkspace: {},
        remoteBrowserPageHandlesByPageId: {},
        terminalLayoutsByTabId: {},
        localOnlyScrollbackByTabId: {},
        repos: [repo],
        worktreesByRepo: {
          repo1: saved.map((path) =>
            makeWorktree({
              id: `repo1::${path}`,
              repoId: repo.id,
              path,
              branch: 'refs/heads/feature',
              linkedPR: 42
            })
          )
        },
        tabsByWorktree: tabs,
        unifiedTabsByWorktree: Object.fromEntries(
          sessions.map((path, i) => {
            const tab: Tab = {
              id: `t${i}`,
              entityId: `t${i}`,
              groupId: 'g',
              worktreeId: `repo1::${path}`,
              contentType: 'terminal',
              label: 'Terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
            return [`repo1::${path}`, [tab]]
          })
        ),
        groupsByWorktree: Object.fromEntries(
          sessions.map((path, i) => [
            `repo1::${path}`,
            [{ id: 'g', worktreeId: `repo1::${path}`, activeTabId: `t${i}`, tabOrder: [`t${i}`] }]
          ])
        ),
        activeGroupIdByWorktree: Object.fromEntries(
          sessions.map((path) => [`repo1::${path}`, 'g'])
        ),
        layoutByWorktree: Object.fromEntries(
          sessions.map((path) => [`repo1::${path}`, { type: 'leaf', groupId: 'g' }])
        )
      })
      rawScan.mockResolvedValue(raw)
      mockApi.worktrees.listDetected.mockImplementation(async () => {
        const result = await listDetectedWorktreesForCapturedRepo(host, repo, () => true)
        if (!result || !('worktrees' in result)) {
          throw new Error('missing listing')
        }
        return result
      })
      await renderer.getState().fetchWorktrees(repo.id)
      expect(
        renderer
          .getState()
          .worktreesByRepo.repo1?.map((row) => row.path)
          .sort()
      ).toEqual(['/repo', ...saved].sort())
      expect(renderer.getState().tabsByWorktree).toEqual(tabs)
      expect(Object.keys(renderer.getState().layoutByWorktree).sort()).toEqual(
        sessions.map((path) => `repo1::${path}`).sort()
      )
      const patch = buildWorkspaceSessionPatch(renderer.getState(), [
        'tabsByWorktree',
        'layoutByWorktree'
      ])
      expect(Object.keys(patch.tabsByWorktree ?? {}).sort()).toEqual(Object.keys(tabs).sort())
      expect(JSON.parse(JSON.stringify(patch)).tabGroupLayouts).toEqual(
        renderer.getState().layoutByWorktree
      )
      expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    }
  }
})
