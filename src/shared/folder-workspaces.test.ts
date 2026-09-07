import { describe, expect, it } from 'vitest'
import { normalizeFolderWorkspaces } from './folder-workspaces'
import type { ProjectGroup } from './project-group-types'

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

    // A runtime-scoped stamp names an authority the desktop store does not own, and it
    // carries no generation to fence on — persisting it would recreate the divergence #12 fixed.
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

  it('inherits the group connection when the workspace omits one', () => {
    const [inherited] = normalizeFolderWorkspaces(
      [{ id: 'ws-3', projectGroupId: 'group-1', name: 'Inherited' }],
      [{ ...folderGroup, connectionId: 'ssh-group' } as ProjectGroup]
    )

    expect(inherited.connectionId).toBe('ssh-group')
  })
})
