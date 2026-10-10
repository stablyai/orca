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
const runtimeRepo: Pick<Repo, 'connectionId' | 'executionHostId'> = {
  connectionId: null,
  executionHostId: 'runtime:owner-runtime'
}
const localRepo: Pick<Repo, 'connectionId' | 'executionHostId'> = {
  connectionId: null,
  executionHostId: 'local'
}

describe.each([
  ['getGitHubRepoSourceSettings', getGitHubRepoSourceSettings],
  ['getGitHubWorkItemSourceSettings', getGitHubWorkItemSourceSettings]
])('%s with a GitHub task source', (_name, resolve) => {
  it('keeps a runtime-owned repo on its owner when the source has no runtime (#7623)', () => {
    expect(resolve(settings, runtimeRepo, localSource)?.activeRuntimeEnvironmentId).toBe(
      'owner-runtime'
    )
  })

  it('lets a runtime source override the repo owner', () => {
    expect(
      resolve(settings, runtimeRepo, { ...localSource, hostId: 'runtime:source-runtime' })
        ?.activeRuntimeEnvironmentId
    ).toBe('source-runtime')
  })

  it('never routes a local source to the focused runtime', () => {
    expect(resolve(settings, localRepo, localSource)?.activeRuntimeEnvironmentId).toBeNull()
    expect(resolve(settings, undefined, localSource)?.activeRuntimeEnvironmentId).toBeNull()
  })
})
