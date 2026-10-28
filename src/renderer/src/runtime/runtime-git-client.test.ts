import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generateRuntimeCommitMessage,
  generateRuntimePullRequestFields
} from './runtime-git-generation-client'
import { getRuntimeGitStatus } from './runtime-git-status-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

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
  it('uses the backing folder path for local folder-workspace status', async () => {
    gitStatus.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const workspaceId = '123e4567-e89b-12d3-a456-426614174000'

    await getRuntimeGitStatus({
      target: { kind: 'local' as const },
      worktreeId: `folder-repo::/home/user::workspace:${workspaceId}`,
      worktreePath: `/home/user::workspace:${workspaceId}`
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/home/user',
      connectionId: undefined
    })
  })

  it('forwards line-stat reuse to local status and cancels tokenized work on abort', async () => {
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
    const statusArgs = gitStatus.mock.calls[0]?.[0] as { requestToken?: string }
    controller.abort()
    resolveStatus({ entries: [], conflictOperation: 'unknown' })
    // Best-effort main cancellation may still resolve status; aborted calls must reject rather than publish fresh results.
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      reuseLineStats: true,
      requestToken: expect.any(String)
    })
    expect(gitCancelStatus).toHaveBeenCalledWith({ requestToken: statusArgs.requestToken })
  })

  it('passes the raw worktree id to local generation IPC', async () => {
    // Why: the meta key keeps the `::workspace:<uuid>` suffix that the cwd path strips.
    const workspaceId = '123e4567-e89b-12d3-a456-426614174000'
    const worktreeId = `folder-repo::/home/user::workspace:${workspaceId}`
    const context = {
      target: { kind: 'local' as const },
      worktreeId,
      worktreePath: `/home/user::workspace:${workspaceId}`
    }

    await generateRuntimeCommitMessage(context)
    await generateRuntimePullRequestFields(context, {
      base: 'main',
      title: '',
      body: '',
      draft: false
    })

    expect(gitGenerateCommitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId, worktreePath: '/home/user' })
    )
    expect(gitGeneratePullRequestFields).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId, worktreePath: '/home/user' })
    )
  })
})
