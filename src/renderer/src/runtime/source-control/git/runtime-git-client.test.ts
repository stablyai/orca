import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitStatus, supportsRuntimeGitRepositories } from './runtime-git-status-client'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from '../../../components/right-sidebar/file-explorer/tree/file-explorer-repository-observer'
import { buildExplorerRepositoryDecorations } from '../../../components/right-sidebar/file-explorer/tree/file-explorer-repository-decorations'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  createCompatibleRuntimeStatusResponse,
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
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        cancelSubscription: vi.fn().mockResolvedValue(undefined)
      }
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

it('sends no scoped Git call to an old host and discovers support after contact cache retirement', async () => {
  const context = {
    target: { kind: 'environment' as const, environmentId: 'nested-host' },
    worktreeId: 'folder:test',
    worktreePath: '/folder'
  }
  const request = { repositoryPaths: ['child'], repositoryIntent: 'probe' as const }
  let supported = false
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'status.get') {
      const response = createCompatibleRuntimeStatusResponse()
      if (!supported) {
        response.result.capabilities = []
      }
      return response
    }
    return {
      id: 'git',
      ok: true,
      result: {
        entries: [],
        conflictOperation: 'unknown',
        repositoryStatuses: [{ path: 'child', kind: 'repository' }]
      }
    }
  })
  expect((await getRuntimeGitStatus(context, request)).repositoryStatuses).toBeUndefined()
  for (let index = 0; index < 20; index++) {
    expect(
      (
        await getRuntimeGitStatus(context, {
          repositoryPaths: [`child${index}`],
          repositoryIntent: 'status'
        })
      ).repositoryStatuses
    ).toBeUndefined()
  }
  expect(runtimeEnvironmentTransportCall.mock.calls.map(([args]) => args.method)).toEqual([
    'status.get'
  ])
  vi.useFakeTimers()
  let sources: readonly ExplorerRepositorySource[] = []
  const observer = new FileExplorerRepositoryObserver(
    async (scoped, signal) =>
      (await getRuntimeGitStatus(context, { ...scoped, signal })).repositoryStatuses,
    (next) => {
      sources = next
    },
    () => supportsRuntimeGitRepositories(context)
  )
  observer.setFrontier([{ path: 'child', marker: true }], ['child', 'child/tracked.txt'])
  observer.setVisible(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sources).toEqual([])
  expect(
    buildExplorerRepositoryDecorations(
      [{ path: 'child/tracked.txt', status: 'modified', area: 'unstaged' }],
      sources
    ).statusByRelativePath.get('child/tracked.txt')
  ).toBe('modified')
  expect(runtimeEnvironmentTransportCall.mock.calls.map(([args]) => args.method)).toEqual([
    'status.get'
  ])
  supported = true
  clearRuntimeCompatibilityCacheForTests()
  expect((await getRuntimeGitStatus(context, request)).repositoryStatuses).toEqual([
    { path: 'child', kind: 'repository' }
  ])
  expect(
    runtimeEnvironmentTransportCall.mock.calls
      .filter(([args]) => args.method === 'git.status')
      .map(([args]) => args.params)
  ).toEqual([
    expect.objectContaining({
      worktree: 'id:folder:test',
      repositoryPaths: ['child'],
      repositoryIntent: 'probe'
    })
  ])
  observer.setDemand(['child/tracked.txt'])
  observer.invalidate()
  await vi.advanceTimersByTimeAsync(4000)
  expect(sources.map((source) => source.path)).toEqual(['child'])
  const legacyBadge = () =>
    buildExplorerRepositoryDecorations(
      [{ path: 'child/tracked.txt', status: 'modified', area: 'unstaged' }],
      sources
    ).statusByRelativePath.get('child/tracked.txt')
  expect(legacyBadge()).toBeUndefined()
  supported = false
  clearRuntimeCompatibilityCacheForTests()
  const scopedBefore = runtimeEnvironmentTransportCall.mock.calls.filter(
    ([args]) => args.method === 'git.status'
  ).length
  observer.invalidate()
  await vi.advanceTimersByTimeAsync(4000)
  expect(sources).toEqual([])
  expect(legacyBadge()).toBe('modified')
  expect(
    runtimeEnvironmentTransportCall.mock.calls.filter(([args]) => args.method === 'git.status')
  ).toHaveLength(scopedBefore)
  supported = true
  clearRuntimeCompatibilityCacheForTests()
  observer.invalidate()
  await vi.advanceTimersByTimeAsync(4000)
  expect(sources.map((source) => source.path)).toEqual(['child'])
  observer.dispose()
  vi.useRealTimers()
})
