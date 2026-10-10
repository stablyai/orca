import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import { getGitHubRepoSourceSettings, getGitHubWorkItemSourceSettings } from './work-item-routing'

const settings = {
  ...getDefaultSettings('/home/user'),
  activeRuntimeEnvironmentId: 'focused-runtime'
}
const localSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'repo-1'
}
function makeRepo(executionHostId: Repo['executionHostId']): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '',
    addedAt: 0,
    connectionId: null,
    executionHostId
  }
}
const runtimeRepo = makeRepo('runtime:owner-runtime')
const localRepo = makeRepo('local')

function stateWith(repos: Repo[]): Parameters<typeof getGitHubRepoSourceSettings>[0] {
  return { settings, repos }
}

describe.each([
  ['getGitHubRepoSourceSettings', getGitHubRepoSourceSettings],
  ['getGitHubWorkItemSourceSettings', getGitHubWorkItemSourceSettings]
])('%s with a GitHub task source', (_name, resolve) => {
  it('keeps a runtime-owned repo on its owner when the source has no runtime (#7623)', () => {
    expect(
      resolve(stateWith([runtimeRepo]), runtimeRepo, localSource)?.activeRuntimeEnvironmentId
    ).toBe('owner-runtime')
  })

  it('lets a runtime source override the repo owner', () => {
    expect(
      resolve(stateWith([runtimeRepo]), runtimeRepo, {
        ...localSource,
        hostId: 'runtime:source-runtime'
      })?.activeRuntimeEnvironmentId
    ).toBe('source-runtime')
  })

  it('never routes a local source to the focused runtime', () => {
    expect(
      resolve(stateWith([localRepo]), localRepo, localSource)?.activeRuntimeEnvironmentId
    ).toBeNull()
    expect(resolve(stateWith([]), undefined, localSource)?.activeRuntimeEnvironmentId).toBeNull()
  })

  it('keeps a local source local when the repo id also exists on a server', () => {
    const state = stateWith([runtimeRepo, localRepo])
    expect(resolve(state, runtimeRepo, localSource)?.activeRuntimeEnvironmentId).toBeNull()
    expect(resolve(state, localRepo, localSource)?.activeRuntimeEnvironmentId).toBeNull()
  })
})
