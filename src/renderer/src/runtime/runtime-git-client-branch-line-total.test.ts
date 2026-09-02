import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitStatus } from './runtime-git-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const MERGE_BASE = '1f3c0d9a5b6e7f8091a2b3c4d5e6f708192a3b4c'

const gitStatus = vi.fn()
const gitCancelStatus = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitStatus.mockReset()
  gitStatus.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
  gitCancelStatus.mockReset()
  gitCancelStatus.mockResolvedValue(undefined)
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-1',
    ok: true,
    result: { entries: [], conflictOperation: 'unknown' },
    _meta: { runtimeId: 'remote-runtime' }
  })
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      git: { status: gitStatus, cancelStatus: gitCancelStatus },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('branch line total merge base on git status requests', () => {
  it('forwards the merge base to local git status only when the chip asked for it', async () => {
    const context = {
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    }

    await getRuntimeGitStatus(context, { branchLineTotalMergeBase: MERGE_BASE })
    await getRuntimeGitStatus(context, {})
    await getRuntimeGitStatus(context)

    expect(gitStatus).toHaveBeenNthCalledWith(1, {
      worktreePath: '/repo',
      connectionId: undefined,
      branchLineTotalMergeBase: MERGE_BASE
    })
    expect(gitStatus).toHaveBeenNthCalledWith(2, {
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitStatus).toHaveBeenNthCalledWith(3, {
      worktreePath: '/repo',
      connectionId: undefined
    })
  })

  it('forwards the merge base through the active runtime environment', async () => {
    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { branchLineTotalMergeBase: MERGE_BASE }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.status',
      params: { worktree: 'id:wt-1', branchLineTotalMergeBase: MERGE_BASE },
      timeoutMs: 15_000
    })
  })

  it('omits the merge base param entirely for a remote status with no visible chip', async () => {
    // Why: Rule-1 wire safety — an old server must see the exact params it
    // already understands, and a hidden chip must not cost a remote diff.
    await getRuntimeGitStatus({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.status',
      params: { worktree: 'id:wt-1' },
      timeoutMs: 15_000
    })
  })

  it('keeps the merge base alongside reuse and cache-bypass flags', async () => {
    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      {
        reuseLineStats: true,
        bypassEffectiveUpstreamNegativeCache: true,
        branchLineTotalMergeBase: MERGE_BASE
      }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.status',
      params: {
        worktree: 'id:wt-1',
        bypassEffectiveUpstreamNegativeCache: true,
        reuseLineStats: true,
        branchLineTotalMergeBase: MERGE_BASE
      },
      timeoutMs: 15_000
    })
  })
})
