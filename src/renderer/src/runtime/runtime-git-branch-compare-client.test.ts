import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitBranchCompareResult } from '../../../shared/git-diff-compare-types'
import { getRuntimeGitBranchCompare } from './runtime-git-diff-client'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'

const call = vi.fn()

beforeEach(() => {
  call.mockReset()
  clearRuntimeCompatibilityCacheForTests()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? call(args)
      }
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

it('requests the selected tip remotely while accepting an older host response', async () => {
  const result: GitBranchCompareResult = {
    summary: {
      baseRef: 'selected-base',
      baseOid: 'base',
      compareRef: 'feature',
      headOid: 'head',
      mergeBase: 'legacy-fork',
      changedFiles: 0,
      status: 'ready'
    },
    entries: []
  }
  call.mockResolvedValue({ id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'remote-runtime' } })

  await expect(
    getRuntimeGitBranchCompare(
      {
        target: { kind: 'environment', environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      'selected-base'
    )
  ).resolves.toEqual(result)

  expect(call).toHaveBeenCalledWith({
    selector: 'env-1',
    method: 'git.branchCompare',
    params: {
      worktree: 'id:wt-1',
      baseRef: 'selected-base',
      compareBaseTip: true,
      admissionTier: 'interactive'
    },
    timeoutMs: 15_000
  })
})
