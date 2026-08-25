import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const importNested = vi.fn()
const listGroups = vi.fn()
const listFolders = vi.fn()
const listRepos = vi.fn()

const result = {
  group: null,
  repos: [],
  importedCount: 0,
  alreadyKnownCount: 0,
  failedCount: 0
}

beforeEach(() => {
  vi.clearAllMocks()
  importNested.mockResolvedValue(result)
  listGroups.mockResolvedValue([])
  listFolders.mockResolvedValue([])
  listRepos.mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      projectGroups: { importNested, list: listGroups },
      folderWorkspaces: { list: listFolders },
      repos: { list: listRepos }
    }
  })
})

describe('nested import partial catalog refresh failures', () => {
  it.each([
    ['project groups', listGroups],
    ['folder workspaces', listFolders],
    ['repos', listRepos]
  ])('returns the import result when the %s refresh fails', async (_label, failingList) => {
    const calls: string[] = []
    listGroups.mockImplementation(async () => {
      calls.push('groups')
      if (failingList === listGroups) {
        throw new Error('groups failed')
      }
      return []
    })
    listFolders.mockImplementation(async () => {
      calls.push('folders')
      if (failingList === listFolders) {
        throw new Error('folders failed')
      }
      return []
    })
    listRepos.mockImplementation(async () => {
      calls.push('repos')
      if (failingList === listRepos) {
        throw new Error('repos failed')
      }
      return []
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = createTestStore()
    try {
      await expect(
        store.getState().importNestedRepos({
          parentPath: '/workspace',
          groupName: 'Workspace',
          projectPaths: [],
          mode: 'group'
        })
      ).resolves.toEqual(result)
    } finally {
      errorSpy.mockRestore()
    }

    expect(calls).toEqual(['groups', 'folders', 'repos'])
    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })
})
