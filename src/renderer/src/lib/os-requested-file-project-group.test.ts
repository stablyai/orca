import { describe, expect, it } from 'vitest'
import {
  findLocalProjectGroupByName,
  findLocalProjectGroupForFilePath,
  findLocalProjectGroupForOsRequestedFile
} from './os-requested-file-project-group'

describe('findLocalProjectGroupForFilePath', () => {
  it('chooses a local group whose parentPath contains the file', () => {
    const group = {
      id: 'g1',
      name: 'orca',
      parentPath: '/Users/x/projects',
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    expect(findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [group])).toEqual(
      group
    )
  })

  it('does not choose a remote group (truthy connectionId) with a matching parentPath', () => {
    const remoteGroup = {
      id: 'g1',
      name: 'orca',
      parentPath: '/Users/x/projects',
      connectionId: 'ssh-host-1',
      executionHostId: null,
      createdAt: 1
    }
    expect(
      findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [remoteGroup])
    ).toBeNull()
  })

  it('does not choose a group whose executionHostId is a remote runtime, even without connectionId', () => {
    const runtimeGroup = {
      id: 'g1',
      name: 'orca',
      parentPath: '/Users/x/projects',
      connectionId: null,
      executionHostId: 'runtime:env-1',
      createdAt: 1
    }
    expect(
      findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [runtimeGroup])
    ).toBeNull()
  })

  it('skips a group with parentPath: null', () => {
    const group = {
      id: 'g1',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    expect(findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [group])).toBeNull()
  })

  it('returns null when no group matches', () => {
    const group = {
      id: 'g1',
      name: 'orca',
      parentPath: '/Users/x/other',
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    expect(findLocalProjectGroupForFilePath('/Users/x/projects/orca/note.md', [group])).toBeNull()
  })
})

describe('findLocalProjectGroupByName', () => {
  it('rejects a remote group (truthy connectionId) with a matching name', () => {
    const remoteGroup = {
      id: 'g1',
      name: 'orca',
      parentPath: null,
      connectionId: 'ssh-host-1',
      executionHostId: null,
      createdAt: 1
    }
    expect(findLocalProjectGroupByName('orca', [remoteGroup])).toBeNull()
  })

  it('picks the oldest createdAt when several local groups share the name', () => {
    const older = {
      id: 'older',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 100
    }
    const newer = {
      id: 'newer',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 200
    }
    expect(findLocalProjectGroupByName('orca', [newer, older])).toEqual(older)
  })

  it('returns null when no group has that name', () => {
    const group = {
      id: 'g1',
      name: 'other-name',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    expect(findLocalProjectGroupByName('orca', [group])).toBeNull()
  })
})

describe('findLocalProjectGroupForOsRequestedFile', () => {
  it('reuses a name-matching local group when no parentPath match exists', () => {
    const nameMatch = {
      id: 'g1',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    expect(
      findLocalProjectGroupForOsRequestedFile('/Users/x/projects/orca/note.md', 'orca', [nameMatch])
    ).toEqual(nameMatch)
  })

  it('lets a parentPath match win over a name match (order matters)', () => {
    const pathMatch = {
      id: 'path-match',
      name: 'unrelated',
      parentPath: '/Users/x/projects',
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    const nameMatch = {
      id: 'name-match',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    const result = findLocalProjectGroupForOsRequestedFile(
      '/Users/x/projects/orca/note.md',
      'orca',
      [nameMatch, pathMatch]
    )
    expect(result).toEqual(pathMatch)
  })

  it('rejects a remote group with a matching name', () => {
    const remoteNameMatch = {
      id: 'g1',
      name: 'orca',
      parentPath: null,
      connectionId: 'ssh-host-1',
      executionHostId: null,
      createdAt: 1
    }
    expect(
      findLocalProjectGroupForOsRequestedFile('/Users/x/projects/orca/note.md', 'orca', [
        remoteNameMatch
      ])
    ).toBeNull()
  })

  it('picks the oldest local same-name group deterministically', () => {
    const older = {
      id: 'older',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 100
    }
    const newer = {
      id: 'newer',
      name: 'orca',
      parentPath: null,
      connectionId: null,
      executionHostId: null,
      createdAt: 200
    }
    expect(
      findLocalProjectGroupForOsRequestedFile('/Users/x/projects/orca/note.md', 'orca', [
        newer,
        older
      ])
    ).toEqual(older)
  })

  it('returns null when nothing matches by path or name', () => {
    const group = {
      id: 'g1',
      name: 'other-name',
      parentPath: '/Users/x/other',
      connectionId: null,
      executionHostId: null,
      createdAt: 1
    }
    expect(
      findLocalProjectGroupForOsRequestedFile('/Users/x/projects/orca/note.md', 'orca', [group])
    ).toBeNull()
  })
})
