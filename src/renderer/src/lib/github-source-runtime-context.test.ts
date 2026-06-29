import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  canUseGitHubRepoContext,
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost,
  getGitHubSourceRuntimeTarget
} from './github-source-runtime-context'

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
