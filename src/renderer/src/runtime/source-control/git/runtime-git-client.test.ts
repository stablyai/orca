import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitStatus } from './runtime-git-status-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../rpc/compatibility/runtime-compatibility-cache'

const gitStatus = vi.fn()
const gitCancelStatus = vi.fn()
const gitCheckIgnored = vi.fn()
const gitSubmoduleStatus = vi.fn()
const gitDiff = vi.fn()
const gitBranchCompare = vi.fn()
const gitHistory = vi.fn()
const gitBulkStage = vi.fn()
const gitBulkDiscard = vi.fn()
const gitCommit = vi.fn()
const gitFetch = vi.fn()
const gitFastForward = vi.fn()
const gitPush = vi.fn()
const gitRebaseFromBase = vi.fn()
const gitGenerateCommitMessage = vi.fn()
const gitGeneratePullRequestFields = vi.fn()
const gitDiscoverCommitMessageModels = vi.fn()
const gitCancelGenerateCommitMessage = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitStatus.mockReset()
  gitCancelStatus.mockReset()
  gitCancelStatus.mockResolvedValue(undefined)
  gitCheckIgnored.mockReset()
  gitSubmoduleStatus.mockReset()
  gitDiff.mockReset()
  gitBranchCompare.mockReset()
  gitHistory.mockReset()
  gitBulkStage.mockReset()
  gitBulkDiscard.mockReset()
  gitCommit.mockReset()
  gitFetch.mockReset()
  gitFastForward.mockReset()
  gitPush.mockReset()
  gitRebaseFromBase.mockReset()
  gitGenerateCommitMessage.mockReset()
  gitGeneratePullRequestFields.mockReset()
  gitDiscoverCommitMessageModels.mockReset()
  gitCancelGenerateCommitMessage.mockReset()
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
        cancelStatus: gitCancelStatus,
        checkIgnored: gitCheckIgnored,
        submoduleStatus: gitSubmoduleStatus,
        diff: gitDiff,
        branchCompare: gitBranchCompare,
        history: gitHistory,
        bulkStage: gitBulkStage,
        bulkDiscard: gitBulkDiscard,
        commit: gitCommit,
        fetch: gitFetch,
        fastForward: gitFastForward,
        push: gitPush,
        rebaseFromBase: gitRebaseFromBase,
        generateCommitMessage: gitGenerateCommitMessage,
        generatePullRequestFields: gitGeneratePullRequestFields,
        discoverCommitMessageModels: gitDiscoverCommitMessageModels,
        cancelGenerateCommitMessage: gitCancelGenerateCommitMessage
      },
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('runtime git client', () => {
  it('rejects aborted local status when its pending response resolves', async () => {
    const controller = new AbortController()
    let resolveStatus!: (value: { entries: never[]; conflictOperation: string }) => void
    gitStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        })
    )

    const request = getRuntimeGitStatus(
      {
        target: { kind: 'local' as const },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { reuseLineStats: true, signal: controller.signal }
    )
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalled())
    controller.abort()
    resolveStatus({ entries: [], conflictOperation: 'unknown' })
    // Best-effort main cancellation may still resolve status; aborted calls must reject rather than publish fresh results.
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
