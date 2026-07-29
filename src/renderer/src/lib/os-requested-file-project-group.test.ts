import { describe, expect, it } from 'vitest'
import { findLocalProjectGroupForFilePath } from './os-requested-file-project-group'

describe('findLocalProjectGroupForFilePath', () => {
  it('chooses a local group whose parentPath contains the file', () => {
    const group = {
      id: 'g1',
      parentPath: '/Users/x/projects',
      connectionId: null,
      executionHostId: null
    }
    expect(findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [group])).toEqual(
      group
    )
  })

  it('does not choose a remote group (truthy connectionId) with a matching parentPath', () => {
    const remoteGroup = {
      id: 'g1',
      parentPath: '/Users/x/projects',
      connectionId: 'ssh-host-1',
      executionHostId: null
    }
    expect(
      findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [remoteGroup])
    ).toBeNull()
  })

  it('does not choose a group whose executionHostId is a remote runtime, even without connectionId', () => {
    const runtimeGroup = {
      id: 'g1',
      parentPath: '/Users/x/projects',
      connectionId: null,
      executionHostId: 'runtime:env-1'
    }
    expect(
      findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [runtimeGroup])
    ).toBeNull()
  })

  it('skips a group with parentPath: null', () => {
    const group = { id: 'g1', parentPath: null, connectionId: null, executionHostId: null }
    expect(findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [group])).toBeNull()
  })

  it('returns null when no group matches', () => {
    const group = {
      id: 'g1',
      parentPath: '/Users/x/other',
      connectionId: null,
      executionHostId: null
    }
    expect(findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [group])).toBeNull()
  })
})
