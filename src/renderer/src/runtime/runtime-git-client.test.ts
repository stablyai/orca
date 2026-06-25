/* eslint-disable max-lines -- Why: runtime git routing tests share compatibility-cache and IPC stubs; splitting would hide cross-environment contract drift. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bulkDiscardRuntimeGitPaths,
  bulkStageRuntimeGitPaths,
  cancelRuntimeGenerateCommitMessage,
  commitRuntimeGit,
  discoverRuntimeCommitMessageModels,
  fastForwardRuntimeGit,
  fetchRuntimeGit,
  generateRuntimeCommitMessage,
  getRuntimeGitDiff,
  getRuntimeGitHistory,
  getRuntimeGitIgnoredPaths,
  getRuntimeGitStatus,
  pushRuntimeGit,
  rebaseRuntimeGitFromBase
} from './runtime-git-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const gitStatus = vi.fn()
const gitCheckIgnored = vi.fn()
const gitDiff = vi.fn()
const gitHistory = vi.fn()
const gitBulkStage = vi.fn()
const gitBulkDiscard = vi.fn()
const gitCommit = vi.fn()
const gitFetch = vi.fn()
const gitFastForward = vi.fn()
const gitPush = vi.fn()
const gitRebaseFromBase = vi.fn()
const gitGenerateCommitMessage = vi.fn()
const gitDiscoverCommitMessageModels = vi.fn()
const gitCancelGenerateCommitMessage = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  gitStatus.mockReset()
  gitCheckIgnored.mockReset()
  gitDiff.mockReset()
  gitHistory.mockReset()
  gitBulkStage.mockReset()
  gitBulkDiscard.mockReset()
  gitCommit.mockReset()
  gitFetch.mockReset()
  gitFastForward.mockReset()
  gitPush.mockReset()
  gitRebaseFromBase.mockReset()
  gitGenerateCommitMessage.mockReset()
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
        checkIgnored: gitCheckIgnored,
        diff: gitDiff,
        history: gitHistory,
        bulkStage: gitBulkStage,
        bulkDiscard: gitBulkDiscard,
        commit: gitCommit,
        fetch: gitFetch,
        fastForward: gitFastForward,
        push: gitPush,
        rebaseFromBase: gitRebaseFromBase,
        generateCommitMessage: gitGenerateCommitMessage,
        discoverCommitMessageModels: gitDiscoverCommitMessageModels,
        cancelGenerateCommitMessage: gitCancelGenerateCommitMessage
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

  it('forwards upstream-negative-cache bypass to local git status only when enabled', async () => {
    gitStatus.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })

    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { bypassEffectiveUpstreamNegativeCache: true }
    )
    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { bypassEffectiveUpstreamNegativeCache: false }
    )

    expect(gitStatus).toHaveBeenNthCalledWith(1, {
      worktreePath: '/repo',
      connectionId: undefined,
      bypassEffectiveUpstreamNegativeCache: true
    })
    expect(gitStatus).toHaveBeenNthCalledWith(2, {
      worktreePath: '/repo',
      connectionId: undefined
    })
  })

  it('checks ignored paths through local git IPC', async () => {
    gitCheckIgnored.mockResolvedValue(['dist/bundle.js'])

    const result = await getRuntimeGitIgnoredPaths(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      ['dist/bundle.js', 'src/index.ts']
    )

    expect(gitCheckIgnored).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      paths: ['dist/bundle.js', 'src/index.ts']
    })
    expect(result).toEqual(['dist/bundle.js'])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('uses local git IPC for history when no remote runtime is active', async () => {
    gitHistory.mockResolvedValue({
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    })

    await getRuntimeGitHistory(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      { limit: 25, baseRef: 'origin/main' }
    )

    expect(gitHistory).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      limit: 25,
      baseRef: 'origin/main'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
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
    await getRuntimeGitHistory(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { limit: 50, baseRef: 'origin/main' }
    )

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'git.status',
      params: { worktree: 'id:wt-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'git.diff',
      params: {
        worktree: 'id:wt-1',
        filePath: 'src/a.ts',
        staged: false,
        compareAgainstHead: true
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'git.history',
      params: { worktree: 'id:wt-1', limit: 50, baseRef: 'origin/main' },
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
      params: { worktree: 'id:wt-1', includeIgnored: true },
      timeoutMs: 15_000
    })
  })

  it('forwards upstream-negative-cache bypass through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { entries: [], conflictOperation: 'unknown' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await getRuntimeGitStatus(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { bypassEffectiveUpstreamNegativeCache: true }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.status',
      params: { worktree: 'id:wt-1', bypassEffectiveUpstreamNegativeCache: true },
      timeoutMs: 15_000
    })
  })

  it('checks ignored paths through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: ['dist/bundle.js'],
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await getRuntimeGitIgnoredPaths(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      ['dist/bundle.js']
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.checkIgnored',
      params: { worktree: 'id:wt-1', paths: ['dist/bundle.js'] },
      timeoutMs: 15_000
    })
    expect(result).toEqual(['dist/bundle.js'])
  })

  it('routes bulk mutations and remote operations through the active runtime', async () => {
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
    await bulkDiscardRuntimeGitPaths(context, ['c.ts', 'd.ts'])
    await commitRuntimeGit(context, 'feat: test')
    await generateRuntimeCommitMessage(context)
    await cancelRuntimeGenerateCommitMessage(context)
    await pushRuntimeGit(context, {
      publish: true,
      pushTarget: { remoteName: 'origin', branchName: 'feature' }
    })
    await fetchRuntimeGit(context, { remoteName: 'fork', branchName: 'feature' })
    await fastForwardRuntimeGit(context, { remoteName: 'fork', branchName: 'feature' })
    await rebaseRuntimeGitFromBase(context, 'origin/main')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'git.bulkStage',
      params: { worktree: 'id:wt-1', filePaths: ['a.ts', 'b.ts'] },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'git.bulkDiscard',
      params: { worktree: 'id:wt-1', filePaths: ['c.ts', 'd.ts'] },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'git.commit',
      params: { worktree: 'id:wt-1', message: 'feat: test' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'git.generateCommitMessage',
      params: { worktree: 'id:wt-1', commitMessageDiscoveryHostKey: 'runtime:env-1' },
      timeoutMs: 75_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'git.cancelGenerateCommitMessage',
      params: { worktree: 'id:wt-1' },
      timeoutMs: 5_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'git.push',
      params: {
        worktree: 'id:wt-1',
        publish: true,
        pushTarget: { remoteName: 'origin', branchName: 'feature' }
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(7, {
      selector: 'env-1',
      method: 'git.fetch',
      params: {
        worktree: 'id:wt-1',
        pushTarget: { remoteName: 'fork', branchName: 'feature' }
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(8, {
      selector: 'env-1',
      method: 'git.fastForward',
      params: {
        worktree: 'id:wt-1',
        pushTarget: { remoteName: 'fork', branchName: 'feature' }
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(9, {
      selector: 'env-1',
      method: 'git.rebaseFromBase',
      params: { worktree: 'id:wt-1', baseRef: 'origin/main' },
      timeoutMs: 30_000
    })
  })

  it('passes commit-message settings to the active runtime', async () => {
    const commitMessageAi = {
      enabled: true,
      agentId: 'codex' as const,
      selectedModelByAgent: { codex: 'gpt-5.3-codex-spark' },
      selectedThinkingByModel: { 'gpt-5.3-codex-spark': 'medium' },
      customPrompt: 'Prefer concise subjects.',
      customAgentCommand: ''
    }
    const agentCmdOverrides = { codex: 'codex --profile work' }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { success: true, message: 'feat: test' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await generateRuntimeCommitMessage({
      settings: {
        activeRuntimeEnvironmentId: 'env-1',
        commitMessageAi,
        agentCmdOverrides,
        enableGitHubAttribution: true
      },
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.generateCommitMessage',
      params: {
        worktree: 'id:wt-1',
        commitMessageAi,
        agentCmdOverrides,
        enableGitHubAttribution: true,
        commitMessageDiscoveryHostKey: 'runtime:env-1'
      },
      timeoutMs: 75_000
    })
  })

  it('passes one-shot commit-message params to local and runtime generation', async () => {
    const sourceControlAiResolvedParams = {
      agentId: 'codex' as const,
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      customPrompt: 'Use Conventional Commits.'
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { success: true, message: 'feat: test' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await generateRuntimeCommitMessage(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'repo-1::/repo',
        worktreePath: '/repo'
      },
      { sourceControlAiResolvedParams }
    )
    await generateRuntimeCommitMessage(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      { sourceControlAiResolvedParams }
    )

    expect(gitGenerateCommitMessage).toHaveBeenCalledWith({
      worktreePath: '/repo',
      repoId: 'repo-1',
      connectionId: undefined,
      sourceControlAiResolvedParams
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.generateCommitMessage',
      params: {
        worktree: 'id:wt-1',
        commitMessageDiscoveryHostKey: 'runtime:env-1',
        sourceControlAiResolvedParams
      },
      timeoutMs: 75_000
    })
  })

  it('discovers commit-message models through the active runtime', async () => {
    const agentCmdOverrides = { cursor: 'cursor-agent' }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { success: true, models: [{ id: 'auto', label: 'Auto' }], defaultModelId: 'auto' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await discoverRuntimeCommitMessageModels(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1', agentCmdOverrides },
        worktreeId: 'wt-1',
        worktreePath: '/repo'
      },
      'cursor'
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'git.discoverCommitMessageModels',
      params: { worktree: 'id:wt-1', agentId: 'cursor', agentCmdOverrides },
      timeoutMs: 75_000
    })
    expect(gitDiscoverCommitMessageModels).not.toHaveBeenCalled()
  })
})
