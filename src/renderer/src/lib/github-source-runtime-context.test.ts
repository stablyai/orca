import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getActiveRuntimeTarget } from '../runtime/runtime-rpc-client'
import {
  canUseGitHubRepoContext,
  getGitHubMutationRoutingSettings,
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost,
  getGitHubSourceRuntimeTarget
} from './github-source-runtime-context'
import type { RepoRuntimeOwnerState } from './repo-runtime-owner'

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

describe('GitHub source runtime context', () => {
  it('detects runtime-owned GitHub sources', () => {
    expect(getGitHubSourceRuntimeHost(runtimeSourceContext)).toEqual({
      kind: 'runtime',
      id: 'runtime:env-1',
      environmentId: 'env-1'
    })
    expect(getGitHubSourceRuntimeTarget(runtimeSourceContext)).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  it('does not treat non-runtime or non-GitHub sources as runtime GitHub sources', () => {
    expect(getGitHubSourceRuntimeHost({ ...runtimeSourceContext, hostId: 'local' })).toBeNull()
    expect(getGitHubSourceRuntimeHost({ ...runtimeSourceContext, provider: 'gitlab' })).toBeNull()
    expect(getGitHubSourceRuntimeTarget({ ...runtimeSourceContext, provider: 'gitlab' })).toEqual({
      kind: 'local'
    })
  })

  it('allows a repo context from either a local path or runtime source', () => {
    expect(canUseGitHubRepoContext('', runtimeSourceContext)).toBe(true)
    expect(canUseGitHubRepoContext('C:\\workspace\\repo', null)).toBe(true)
    expect(canUseGitHubRepoContext('', { ...runtimeSourceContext, hostId: 'local' })).toBe(false)
  })

  it('uses the source repo id for GitHub runtime calls when available', () => {
    expect(getGitHubRuntimeRepoId(runtimeSourceContext, 'fallback-repo')).toBe('runtime-repo')
    expect(getGitHubRuntimeRepoId({ ...runtimeSourceContext, repoId: null }, 'fallback-repo')).toBe(
      'fallback-repo'
    )
    expect(
      getGitHubRuntimeRepoId({ ...runtimeSourceContext, provider: 'gitlab' }, 'fallback')
    ).toBe('fallback')
  })
})

describe('getGitHubMutationRoutingSettings', () => {
  const runtimeOwnedRepo: RepoRuntimeOwnerState = {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
  }

  function resolveTarget(
    state: RepoRuntimeOwnerState,
    repoId: string | null,
    sourceContext: TaskSourceContext | null
  ): ReturnType<typeof getActiveRuntimeTarget> {
    return getActiveRuntimeTarget(getGitHubMutationRoutingSettings(state, repoId, sourceContext))
  }

  it('routes a runtime-owned repo to its owner runtime when the source view is local (#6957)', () => {
    expect(
      resolveTarget(runtimeOwnedRepo, 'repo-1', {
        ...runtimeSourceContext,
        hostId: 'local',
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'environment', environmentId: 'owner-runtime' })
  })

  it('routes a runtime-owned repo to its owner runtime when there is no source context', () => {
    expect(resolveTarget(runtimeOwnedRepo, 'repo-1', null)).toEqual({
      kind: 'environment',
      environmentId: 'owner-runtime'
    })
  })

  it('lets a runtime source override the repo owner when both name runtimes', () => {
    expect(
      resolveTarget(runtimeOwnedRepo, 'repo-1', {
        ...runtimeSourceContext,
        hostId: 'runtime:source-runtime',
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'environment', environmentId: 'source-runtime' })
  })

  it('keeps an explicitly-local repo on local IPC even while a runtime is focused', () => {
    const localRepo: RepoRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }]
    }
    expect(
      resolveTarget(localRepo, 'repo-1', {
        ...runtimeSourceContext,
        hostId: 'local',
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'local' })
  })

  it('ignores runtime hosts on non-GitHub sources', () => {
    expect(
      resolveTarget(runtimeOwnedRepo, 'repo-1', {
        ...runtimeSourceContext,
        provider: 'gitlab',
        hostId: 'runtime:source-runtime'
      })
    ).toEqual({ kind: 'environment', environmentId: 'owner-runtime' })
  })

  it('never routes a repo without an explicit owner to the globally focused runtime', () => {
    const noOwnerRepo: RepoRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: null }]
    }
    expect(
      resolveTarget(noOwnerRepo, 'repo-1', {
        ...runtimeSourceContext,
        hostId: 'local',
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'local' })
    expect(resolveTarget(noOwnerRepo, 'repo-1', null)).toEqual({ kind: 'local' })
    expect(
      resolveTarget(noOwnerRepo, 'repo-1', {
        ...runtimeSourceContext,
        hostId: 'runtime:source-runtime',
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'environment', environmentId: 'source-runtime' })
  })
})
