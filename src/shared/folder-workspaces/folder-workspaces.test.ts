import { describe, expect, it } from 'vitest'
import { normalizeFolderWorkspaces } from './folder-workspaces'
import type { ProjectGroup } from '../project/groups/project-group-types'

const folderGroup = {
  id: 'group-1',
  name: 'Projects',
  parentPath: '/tmp/projects',
  connectionId: null
} as unknown as ProjectGroup

describe('normalizeFolderWorkspaces host attribution', () => {
  it('drops a stored executionHostId instead of round-tripping it', () => {
    const [workspace] = normalizeFolderWorkspaces(
      [
        {
          id: 'ws-1',
          projectGroupId: 'group-1',
          name: 'Nightly',
          folderPath: '/tmp/projects/nightly',
          connectionId: null,
          executionHostId: 'runtime:env-7'
        }
      ],
      [folderGroup]
    )

    // Runtime stamps name an authority the desktop store does not own and lack a generation fence; persisting them recreates #12 divergence.
    expect(workspace).toBeDefined()
    expect(workspace.executionHostId).toBeUndefined()
    expect(Object.keys(workspace)).not.toContain('executionHostId')
  })

  it('keeps connectionId as the durable host pin', () => {
    const [pinned] = normalizeFolderWorkspaces(
      [
        {
          id: 'ws-2',
          projectGroupId: 'group-1',
          name: 'Pinned',
          folderPath: '/tmp/projects/pinned',
          connectionId: 'ssh-box',
          executionHostId: 'local'
        }
      ],
      [folderGroup]
    )

    expect(pinned.connectionId).toBe('ssh-box')
    expect(pinned.executionHostId).toBeUndefined()
  })
})

describe('normalizeFolderWorkspaces tags', () => {
  it('normalizes persisted tags and omits an empty list', () => {
    const [tagged, untagged] = normalizeFolderWorkspaces(
      [
        {
          id: 'ws-a',
          projectGroupId: 'group-1',
          name: 'A',
          sortOrder: 2,
          tags: [' Web', 'web', 3]
        },
        { id: 'ws-b', projectGroupId: 'group-1', name: 'B', sortOrder: 1, tags: [] }
      ],
      [folderGroup]
    )

    expect(tagged.tags).toEqual(['Web'])
    expect(Object.keys(untagged)).not.toContain('tags')
  })
})
