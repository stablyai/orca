import { describe, expect, it } from 'vitest'
import {
  getSettingsForRepoRuntimeOwner,
  type RepoRuntimeOwnerState
} from '../lib/repo-runtime-owner'
import { resolveGitHubSourceSettings } from '../lib/github-source-runtime-context'
import { getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import type { TaskSourceContext } from '../../../shared/task-source-context'

// Why: exercises the shared resolveGitHubSourceSettings helper that both
// GitHubItemDialog and PullRequestPage merge panels route through, so a revert
// to bare/unconditional source routing (issue #6957 / follow-up #7623) fails
// here. A runtime-owned repo whose GitHub source view is local must still merge
// on the owner runtime, not fall back to local `gh:mergePR`.
function resolveMergeTarget(
  state: RepoRuntimeOwnerState,
  repoId: string | null,
  sourceContext: TaskSourceContext | null
): ReturnType<typeof getActiveRuntimeTarget> {
  const repoOwnerSettings = getSettingsForRepoRuntimeOwner(state, repoId)
  return getActiveRuntimeTarget(resolveGitHubSourceSettings(repoOwnerSettings, sourceContext))
}

function githubSource(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return { kind: 'task-source', provider: 'github', projectId: 'p', hostId, repoId: 'repo-1' }
}

describe('GitHub PR merge routing (shared repo-owner-aware resolver)', () => {
  const runtimeOwnedRepo: RepoRuntimeOwnerState = {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
  }

  it('routes a runtime-owned repo to its owner runtime when the source view is local (#6957)', () => {
    expect(resolveMergeTarget(runtimeOwnedRepo, 'repo-1', githubSource('local'))).toEqual({
      kind: 'environment',
      environmentId: 'owner-runtime'
    })
  })

  it('routes a runtime-owned repo to its owner runtime when there is no source context', () => {
    expect(resolveMergeTarget(runtimeOwnedRepo, 'repo-1', null)).toEqual({
      kind: 'environment',
      environmentId: 'owner-runtime'
    })
  })

  it('lets a runtime source override the repo owner when both are runtimes', () => {
    expect(
      resolveMergeTarget(runtimeOwnedRepo, 'repo-1', githubSource('runtime:source-runtime'))
    ).toEqual({ kind: 'environment', environmentId: 'source-runtime' })
  })

  it('keeps an explicitly-local repo on local IPC even while a runtime is focused', () => {
    const localRepo: RepoRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }]
    }
    expect(resolveMergeTarget(localRepo, 'repo-1', githubSource('local'))).toEqual({
      kind: 'local'
    })
  })
})
