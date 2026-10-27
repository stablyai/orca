import { describe, expect, it } from 'vitest'
import {
  project,
  projectHostSetups,
  repo,
  remoteRepo
} from '../../sidebar/worktree-list/grouping/worktree-list-groups-test-fixtures'
import { getActivityProjectLabelsByRepoId } from './activity-thread-grouping'

describe('activity project labels', () => {
  it('uses the logical project name for local and remote checkouts', () => {
    const labels = getActivityProjectLabelsByRepoId([repo, remoteRepo], {
      projects: [project],
      projectHostSetups
    })
    expect(labels.get(repo.id)).toBe('Orca')
    expect(labels.get(remoteRepo.id)).toBe('Orca')
  })

  it('uses the registered folder name when no logical project catalog row exists', () => {
    const folder = { ...repo, id: 'folder-1', kind: 'folder' as const, displayName: 'Client notes' }
    const labels = getActivityProjectLabelsByRepoId([folder], {
      projects: [],
      projectHostSetups: []
    })
    expect(labels.get(folder.id)).toBe('Client notes')
  })

})
