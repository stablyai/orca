import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../shared/types'

type LocalProjectGroup = Pick<
  ProjectGroup,
  'id' | 'parentPath' | 'connectionId' | 'executionHostId'
>

let nextId = 0

const store = {
  worktreesByRepo: {} as Record<string, { id: string; path: string }[]>,
  folderWorkspaces: [] as FolderWorkspace[],
  projectGroups: [] as LocalProjectGroup[],
  createProjectGroup: vi.fn(async (name: string) => {
    const group: LocalProjectGroup = {
      id: `group-${++nextId}`,
      parentPath: '/Users/x/projects',
      connectionId: null,
      executionHostId: null
    }
    store.projectGroups.push(group)
    return { ...group, name } as unknown as ProjectGroup
  }),
  createFolderWorkspace: vi.fn(
    async (args: { projectGroupId: string; name?: string; folderPath?: string | null }) => {
      const workspace = {
        id: `folder-${++nextId}`,
        projectGroupId: args.projectGroupId,
        name: args.name ?? '',
        folderPath: args.folderPath ?? ''
      } as unknown as FolderWorkspace
      store.folderWorkspaces.push(workspace)
      return workspace
    }
  ),
  openFile: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string) => value
}))

import { openOsRequestedFile } from './open-os-requested-file'

beforeEach(() => {
  nextId = 0
  store.worktreesByRepo = {}
  store.folderWorkspaces = []
  store.projectGroups = []
  store.createProjectGroup.mockClear()
  store.createFolderWorkspace.mockClear()
  store.openFile.mockClear()
})

describe('openOsRequestedFile serialization', () => {
  it('creates exactly one workspace for two concurrent files in the same not-yet-created folder', async () => {
    const fileA = '/Users/x/projects/newfolder/a.md'
    const fileB = '/Users/x/projects/newfolder/b.md'

    // Why: both start before either awaits the store update — only chain serialization prevents a duplicate.
    await Promise.all([openOsRequestedFile(fileA), openOsRequestedFile(fileB)])

    expect(store.createFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(store.folderWorkspaces).toHaveLength(1)
  })

  it('does not let a rejected call break the chain for a call queued after it', async () => {
    store.createProjectGroup.mockImplementationOnce(async () => {
      throw new Error('boom')
    })

    const first = openOsRequestedFile('/Users/x/projects/broken/a.md')
    const second = openOsRequestedFile('/Users/x/projects/newfolder/b.md')

    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBeUndefined()

    expect(store.createFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(store.folderWorkspaces).toHaveLength(1)
  })
})
