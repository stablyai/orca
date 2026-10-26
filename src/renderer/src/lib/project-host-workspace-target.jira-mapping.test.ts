import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  getRepoWorkspaceCreationTargetHint,
  resolveWorkspaceCreationTarget
} from './project-host-workspace-target'

const localRepo: Repo = {
  id: 'same-id',
  path: '/local',
  displayName: 'Local',
  badgeColor: '',
  addedAt: 0
}
const sshRepo: Repo = { ...localRepo, connectionId: 'builder', path: '/remote' }

describe('mapped repository creation target hints', () => {
  it('uses the execution host and matching catalog project when repository IDs repeat', () => {
    const projection = projectHostSetupProjectionFromRepos([localRepo, sshRepo])
    const setups = projection.setups.map((setup) => ({
      ...setup,
      projectId: setup.hostId === 'local' ? 'local-project' : 'ssh-project'
    }))

    expect(getRepoWorkspaceCreationTargetHint(sshRepo, setups)).toEqual({
      projectId: 'ssh-project',
      hostId: 'ssh:builder',
      projectHostSetupId: 'same-id'
    })
  })

  it('supports repositories whose catalog still comes from the legacy projection', () => {
    expect(getRepoWorkspaceCreationTargetHint(sshRepo, [])).toEqual({
      projectId: 'repo:same-id',
      hostId: 'ssh:builder'
    })
  })

  it('retains unique setup precedence when a linked Jira account is on another host', () => {
    const projection = projectHostSetupProjectionFromRepos([sshRepo])
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [sshRepo],
        projects: projection.projects,
        projectHostSetups: projection.setups,
        projectHostSetupId: 'same-id',
        hostId: 'local'
      })
    ).toMatchObject({ status: 'ready', target: { hostId: 'ssh:builder', repo: sshRepo } })
  })

  it('does not select another host when an ambiguous setup lacks the requested host', () => {
    const projection = projectHostSetupProjectionFromRepos([localRepo, sshRepo])
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects: projection.projects,
        projectHostSetups: projection.setups,
        projectHostSetupId: 'same-id',
        hostId: 'ssh:missing'
      })
    ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })

  it('does not pick the first host when two hosts share the setup id and none is named', () => {
    const projection = projectHostSetupProjectionFromRepos([localRepo, sshRepo])
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects: projection.projects,
        projectHostSetups: projection.setups,
        projectHostSetupId: 'same-id'
      })
    ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })

  it('resolves an unnamed shared setup id when only one of its hosts can run it', () => {
    const projection = projectHostSetupProjectionFromRepos([localRepo, sshRepo])
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo, sshRepo],
        projects: projection.projects,
        projectHostSetups: projection.setups,
        projectHostSetupId: 'same-id',
        actionableHostIds: new Set(['ssh:builder'])
      })
    ).toMatchObject({ status: 'ready', target: { hostId: 'ssh:builder', repo: sshRepo } })
  })

  it('keeps an explicit host selection unavailable when only a same-ID setup on another host remains', () => {
    const projection = projectHostSetupProjectionFromRepos([localRepo])
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [localRepo],
        projects: projection.projects,
        projectHostSetups: projection.setups,
        projectHostSetupId: 'same-id',
        projectHostSetupHostId: 'ssh:builder'
      })
    ).toEqual({ status: 'unavailable', reason: 'setup-not-found' })
  })
})
