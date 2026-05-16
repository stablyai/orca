import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bulkStageRuntimeGitPaths,
  commitRuntimeGit,
  getRuntimeGitDiff,
  getRuntimeGitStatus,
  pushRuntimeGit
} from './runtime-git-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const gitStatus = vi.fn()
const gitDiff = vi.fn()
const gitBulkStage = vi.fn()
const gitCommit = vi.fn()
const gitPush = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitStatus.mockReset()
  gitDiff.mockReset()
  gitBulkStage.mockReset()
  gitCommit.mockReset()
  gitPush.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      git: {
        status: gitStatus,
        diff: gitDiff,
        bulkStage: gitBulkStage,
        commit: gitCommit,
        push: gitPush
      },
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('runtime git client', () => {
  it('uses local git IPC when no remote runtime is active', async () => {
    gitStatus.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })

    await getRuntimeGitStatus({
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1'
    })

    expect(gitStatus).toHaveBeenCalledWith({ worktreePath: '/repo', connectionId: 'ssh-1' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('forwards includeIgnored to local git status only when enabled', async () => {
    gitStatus.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })

    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { includeIgnored: true }
    )
    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { includeIgnored: false }
    )

    expect(gitStatus).toHaveBeenNthCalledWith(1, {
      worktreePath: '/repo',
      connectionId: undefined,
      includeIgnored: true
    })
    expect(gitStatus).toHaveBeenNthCalledWith(2, {
      worktreePath: '/repo',
      connectionId: undefined
    })
  })

  it('routes status and diffs through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { entries: [], conflictOperation: 'unknown' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await getRuntimeGitStatus({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
    await getRuntimeGitDiff(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { filePath: 'src/a.ts', staged: false, compareAgainstHead: true }
    )

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'git.status',
      params: { worktree: 'wt-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'git.diff',
      params: {
        worktree: 'wt-1',
        filePath: 'src/a.ts',
        staged: false,
        compareAgainstHead: true
      },
      timeoutMs: 15_000
    })
  })

  it('forwards includeIgnored through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { entries: [], conflictOperation: 'unknown', ignoredPaths: ['dist/'] },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { includeIgnored: true }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.status',
      params: { worktree: 'wt-1', includeIgnored: true },
      timeoutMs: 15_000
    })
  })

  it('routes bulk stage and remote operations through the active runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { success: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    }

    await bulkStageRuntimeGitPaths(context, ['a.ts', 'b.ts'])
    await commitRuntimeGit(context, 'feat: test')
    await pushRuntimeGit(context, { publish: true, pushTarget: { remote: 'origin' } as never })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'git.bulkStage',
      params: { worktree: 'wt-1', filePaths: ['a.ts', 'b.ts'] },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'git.commit',
      params: { worktree: 'wt-1', message: 'feat: test' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'git.push',
      params: { worktree: 'wt-1', publish: true, pushTarget: { remote: 'origin' } },
      timeoutMs: 30_000
    })
  })
})
