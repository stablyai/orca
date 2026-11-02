import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  getGitHubRepoRoutingTarget,
  resolveGitHubRepoOperationOwner
} from './github-source-runtime-context'
import type { RepoRuntimeOwnerState } from './repo-runtime-owner'

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

describe('getGitHubRepoRoutingTarget', () => {
  const runtimeOwnedRepo: RepoRuntimeOwnerState = {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
  }

  function resolveTarget(
    state: RepoRuntimeOwnerState,
    repoId: string | null,
    sourceContext: TaskSourceContext | null
  ): RuntimeClientTarget {
    return getGitHubRepoRoutingTarget(state, repoId, sourceContext)
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

  it('keeps a local source local when the repo id also exists on a server', () => {
    const duplicateIds: RepoRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'owner-runtime' },
      repos: [
        { id: 'repo-1', connectionId: null, executionHostId: 'runtime:owner-runtime' },
        { id: 'repo-1', connectionId: null, executionHostId: 'local' }
      ]
    }
    expect(
      resolveTarget(duplicateIds, 'repo-1', {
        ...runtimeSourceContext,
        hostId: 'local',
        repoId: 'repo-1'
      })
    ).toEqual({ kind: 'local' })
  })

  describe('a repo id on two servers', () => {
    const twins: RepoRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'runtime-a' },
      repos: [
        { id: 'repo-1', connectionId: null, executionHostId: 'runtime:runtime-a' },
        { id: 'repo-1', connectionId: null, executionHostId: 'runtime:runtime-b' }
      ]
    }

    it('routes to the host the caller names, not the Active Server focus', () => {
      expect(getGitHubRepoRoutingTarget(twins, 'repo-1', null, 'runtime:runtime-b')).toEqual({
        kind: 'environment',
        environmentId: 'runtime-b'
      })
    })

    it('stays local when the caller names this computer', () => {
      const withLocal: RepoRuntimeOwnerState = {
        ...twins,
        repos: [
          ...(twins.repos ?? []),
          { id: 'repo-1', connectionId: null, executionHostId: 'local' }
        ]
      }
      expect(getGitHubRepoRoutingTarget(withLocal, 'repo-1', null, 'local')).toEqual({
        kind: 'local'
      })
    })

    it('falls back to the Active Server focus only when the caller names no host', () => {
      expect(getGitHubRepoRoutingTarget(twins, 'repo-1', null)).toEqual({
        kind: 'environment',
        environmentId: 'runtime-a'
      })
    })
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

describe('GitHub operation row and target share the existing owner', () => {
  const local: Repo = {
    id: 'same',
    path: '/same',
    displayName: 'local',
    badgeColor: '',
    addedAt: 0,
    executionHostId: 'local',
    ghAccount: { host: 'github.com', user: 'L' }
  }
  const remote: Repo = {
    ...local,
    displayName: 'remote',
    executionHostId: 'runtime:S',
    ghAccount: { host: 'github.com', user: 'S' }
  }
  const state = { repos: [local, remote], settings: { activeRuntimeEnvironmentId: 'S' } }

  it('keeps focused twins, explicit local and known source on their exact account row', () => {
    expect(resolveGitHubRepoOperationOwner(state, { repoId: 'same' })).toEqual({
      repo: remote,
      target: { kind: 'environment', environmentId: 'S' }
    })
    expect(
      resolveGitHubRepoOperationOwner(state, { repoId: 'same', target: { kind: 'local' } })
    ).toEqual({
      repo: local,
      target: { kind: 'local' }
    })
    const sourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      repoId: 'same',
      hostId: 'runtime:S'
    }
    expect(
      resolveGitHubRepoOperationOwner(
        { ...state, settings: { activeRuntimeEnvironmentId: 'other' } },
        {
          repoId: 'same',
          sourceContext
        }
      )
    ).toEqual({ repo: remote, target: { kind: 'environment', environmentId: 'S' } })
    expect(
      resolveGitHubRepoOperationOwner(
        { ...state, repos: [remote, { ...remote, connectionId: 'ssh' }] },
        {
          repoId: 'same',
          sourceContext
        }
      ).repo
    ).toBe(remote)
  })

  it('keeps hostless ambiguity, SSH/WSL and path-only selection without another-host fallback', () => {
    const sourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      repoId: 'same',
      hostId: 'local'
    }
    expect(resolveGitHubRepoOperationOwner(state, { repoId: 'same', sourceContext })).toEqual({
      repo: null,
      target: { kind: 'local' }
    })
    expect(
      resolveGitHubRepoOperationOwner(
        { ...state, repos: [remote, { ...remote }] },
        { repoId: 'same' }
      )
    ).toEqual({
      repo: null,
      target: { kind: 'local' }
    })
    const ssh: Repo = { ...local, executionHostId: null, connectionId: 'ssh' }
    const wsl: Repo = { ...local, path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\same' }
    for (const repo of [ssh, wsl]) {
      expect(
        resolveGitHubRepoOperationOwner({ ...state, repos: [repo] }, { repoId: 'same' })
      ).toEqual({
        repo,
        target: { kind: 'local' }
      })
    }
    expect(
      resolveGitHubRepoOperationOwner({ ...state, repos: [remote] }, { repoPath: '/same' })
    ).toEqual({
      repo: remote,
      target: { kind: 'environment', environmentId: 'S' }
    })
    expect(resolveGitHubRepoOperationOwner(state, { repoPath: '/same' })).toEqual({
      repo: null,
      target: { kind: 'local' }
    })
  })
})
