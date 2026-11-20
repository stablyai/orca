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
  it('keeps connectionId as the durable host pin and discards the runtime stamp', () => {
    const [pinned] = normalizeFolderWorkspaces(
      [
        {
          id: 'ws-2',
          projectGroupId: 'group-1',
          name: 'Pinned',
          folderPath: '/tmp/projects/pinned',
          connectionId: 'ssh-box',
          executionHostId: 'runtime:env-7'
        }
      ],
      [folderGroup]
    )

    expect(pinned).toMatchObject({ connectionId: 'ssh-box' })
    expect(pinned).not.toHaveProperty('executionHostId')
  })
})
