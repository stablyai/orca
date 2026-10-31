import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../folder-workspace-types'
import type { Repo } from '../repo-types'
import { filterFolderWorkspacesForSelectedProjects } from './folder-workspace-project-visibility'

function folderWorkspace(id: string, projectGroupId: string): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function repo(id: string, projectGroupId: string | null): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 0, projectGroupId }
}

describe('filterFolderWorkspacesForSelectedProjects', () => {
  const selectedFolder = folderWorkspace('selected-folder', 'selected-group')
  const otherFolder = folderWorkspace('other-folder', 'other-group')
  const repos = [repo('selected-repo', 'selected-group'), repo('other-repo', 'other-group')]

  it('keeps only folder workspaces associated with selected projects', () => {
    expect(
      filterFolderWorkspacesForSelectedProjects([selectedFolder, otherFolder], repos, [
        'selected-repo'
      ])
    ).toEqual([selectedFolder])
  })

  it('restores every folder workspace when the project filter is cleared', () => {
    expect(
      filterFolderWorkspacesForSelectedProjects([selectedFolder, otherFolder], repos, [])
    ).toEqual([selectedFolder, otherFolder])
  })
})
