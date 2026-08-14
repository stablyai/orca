import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/types'
import { filterFolderWorkspacesFromOtherDevices } from './workspace-creator-visibility'

function makeFolderWorkspace(
  id: string,
  creatorProvenance: FolderWorkspace['creatorProvenance']
): FolderWorkspace {
  return {
    id,
    projectGroupId: 'project',
    name: id,
    folderPath: `/tmp/${id}`,
    executionHostId: 'runtime:env-1',
    creatorProvenance,
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

describe('filterFolderWorkspacesFromOtherDevices', () => {
  it('uses the same client ownership rules as git workspaces', () => {
    const own = makeFolderWorkspace('own', {
      kind: 'paired-device',
      deviceId: 'device-a'
    })
    const other = makeFolderWorkspace('other', {
      kind: 'paired-device',
      deviceId: 'device-b'
    })
    const host = makeFolderWorkspace('host', { kind: 'host' })
    const legacy = makeFolderWorkspace('legacy', undefined)

    const result = filterFolderWorkspacesFromOtherDevices(
      [own, other, host, legacy],
      new Map([['env-1', 'device-a']])
    )

    expect(result.map((workspace) => workspace.id)).toEqual(['own', 'legacy'])
  })
})
