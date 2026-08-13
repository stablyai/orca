import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from './types'
import { normalizeFolderWorkspaces } from './folder-workspaces'

const projectGroups = [
  { id: 'group-1', name: 'Platform', parentPath: '/workspace' } as ProjectGroup
]

function persistedWorkspace(diffComments: unknown): Record<string, unknown> {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    folderPath: '/workspace/platform',
    diffComments
  }
}

describe('normalizeFolderWorkspaces diff comments', () => {
  it('keeps valid persisted notes and drops malformed ones', () => {
    const valid = {
      id: 'note-1',
      worktreeId: 'folder::folder-1',
      filePath: 'README.md',
      lineNumber: 1,
      body: 'Review this',
      createdAt: 100,
      side: 'modified'
    }
    const [workspace] = normalizeFolderWorkspaces(
      [persistedWorkspace([valid, { ...valid, id: 'note-2', body: '   ' }, 42])],
      projectGroups
    )

    expect(workspace.diffComments).toEqual([expect.objectContaining({ id: 'note-1' })])
  })

  it('leaves diffComments unset when the persisted value is not an array', () => {
    const [workspace] = normalizeFolderWorkspaces(
      [persistedWorkspace({ id: 'note-1' })],
      projectGroups
    )

    expect(workspace.diffComments).toBeUndefined()
  })
})
