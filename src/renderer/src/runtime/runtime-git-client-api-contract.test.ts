import { describe, expect, it } from 'vitest'
import * as runtimeGitClient from './runtime-git-client'

const PUBLIC_RUNTIME_GIT_CLIENT_FUNCTIONS = [
  'abortRuntimeGitMerge',
  'abortRuntimeGitRebase',
  'bulkDiscardRuntimeGitPaths',
  'bulkStageRuntimeGitPaths',
  'bulkUnstageRuntimeGitPaths',
  'cancelRuntimeGenerateCommitMessage',
  'cancelRuntimeGeneratePullRequestFields',
  'commitRuntimeGit',
  'discardRuntimeGitPath',
  'discoverRuntimeCommitMessageModels',
  'fastForwardRuntimeGit',
  'fetchRuntimeGit',
  'generateRuntimeCommitMessage',
  'generateRuntimePullRequestFields',
  'getRuntimeGitBranchCompare',
  'getRuntimeGitBranchDiff',
  'getRuntimeGitCommitCompare',
  'getRuntimeGitCommitDiff',
  'getRuntimeGitConflictOperation',
  'getRuntimeGitDiff',
  'getRuntimeGitHistory',
  'getRuntimeGitIgnoredPaths',
  'getRuntimeGitRemoteCommitUrl',
  'getRuntimeGitRemoteFileUrl',
  'getRuntimeGitScope',
  'getRuntimeGitStatus',
  'getRuntimeGitSubmoduleStatus',
  'getRuntimeGitUpstreamStatus',
  'pullRuntimeGit',
  'pushRuntimeGit',
  'rebaseRuntimeGitFromBase',
  'setRuntimeGitStatusUpstreamRefWatch',
  'stageRuntimeGitPath',
  'syncRuntimeGitForkDefaultBranch',
  'unstageRuntimeGitPath'
] as const

describe('runtime Git client API contract', () => {
  it('keeps the stable renderer facade exact and callable', () => {
    const exported: Record<string, unknown> = { ...runtimeGitClient }
    expect(Object.keys(exported).sort()).toEqual([...PUBLIC_RUNTIME_GIT_CLIENT_FUNCTIONS])
    for (const functionName of PUBLIC_RUNTIME_GIT_CLIENT_FUNCTIONS) {
      expect(exported[functionName]).toBeTypeOf('function')
    }
  })
})
