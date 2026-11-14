import { describe, expect, it } from 'vitest'
import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import {
  project,
  projectHostSetups,
  repo,
  remoteRepo
} from '../sidebar/worktree-list/grouping/worktree-list-groups-test-fixtures'
import { getActivityProjectLabelsByRepoHost } from './activity-thread-grouping'

describe('activity project labels', () => {
  it('uses the logical project name for local and remote checkouts', () => {
    const labels = getActivityProjectLabelsByRepoHost([repo, remoteRepo], {
      projects: [project],
      projectHostSetups
    })
    expect(labels.get(getRepoHostIdentity(repo))).toBe('Orca')
    expect(labels.get(getRepoHostIdentity(remoteRepo))).toBe('Orca')
  })

  it('uses the registered folder name when no logical project catalog row exists', () => {
    const folder = { ...repo, id: 'folder-1', kind: 'folder' as const, displayName: 'Client notes' }
    const labels = getActivityProjectLabelsByRepoHost([folder], {
      projects: [],
      projectHostSetups: []
    })
    expect(labels.get(getRepoHostIdentity(folder))).toBe('Client notes')
  })

  it('keeps project labels separate for the same repo id on different hosts', () => {
    const remoteTwin = { ...remoteRepo, id: repo.id }
    const remoteProject = { ...project, id: 'remote-project', displayName: 'Remote Project' }
    const labels = getActivityProjectLabelsByRepoHost([repo, remoteTwin], {
      projects: [project, remoteProject],
      projectHostSetups: [
        projectHostSetups[0],
        { ...projectHostSetups[1], repoId: repo.id, projectId: remoteProject.id }
      ]
    })
    expect(labels.get(getRepoHostIdentity(repo))).toBe('Orca')
    expect(labels.get(getRepoHostIdentity(remoteTwin))).toBe('Remote Project')
  })

  it('keeps host-specific folder names when the project catalog is absent', () => {
    const local = { ...repo, kind: 'folder' as const, displayName: 'Local notes' }
    const ssh = { ...local, connectionId: 'builder', displayName: 'SSH notes' }
    const runtime = {
      ...local,
      executionHostId: 'runtime:home' as const,
      displayName: 'Runtime notes'
    }
    const labels = getActivityProjectLabelsByRepoHost([local, ssh, runtime], {
      projects: [],
      projectHostSetups: []
    })
    expect(labels.get(getRepoHostIdentity(local))).toBe('Local notes')
    expect(labels.get(getRepoHostIdentity(ssh))).toBe('SSH notes')
    expect(labels.get(getRepoHostIdentity(runtime))).toBe('Runtime notes')
  })

  it('preserves checkout names when a project has multiple checkouts on one host', () => {
    const secondCheckout = { ...repo, id: 'repo-2', path: '/tmp/orca-2', displayName: 'Orca 2' }
    const labels = getActivityProjectLabelsByRepoHost([repo, secondCheckout], {
      projects: [project],
      projectHostSetups: [
        projectHostSetups[0],
        {
          ...projectHostSetups[0],
          id: secondCheckout.id,
          repoId: secondCheckout.id,
          path: secondCheckout.path,
          displayName: secondCheckout.displayName
        }
      ]
    })
    expect(labels.get(getRepoHostIdentity(repo))).toBe('orca')
    expect(labels.get(getRepoHostIdentity(secondCheckout))).toBe('Orca 2')
  })
})
