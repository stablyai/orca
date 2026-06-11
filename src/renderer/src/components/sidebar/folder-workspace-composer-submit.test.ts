// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))

import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'hi',
    folderPath: '/repo/platform/hi',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('submitFolderWorkspaceCreate', () => {
  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    vi.restoreAllMocks()
  })

  it('closes the composer after creation even when reveal fails', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.activateAndRevealFolderWorkspace.mockImplementation(() => {
      throw new Error('activation failed')
    })

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'hi',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      agentCmdOverrides: {},
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'hi',
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      undefined
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to activate folder workspace after create:',
      expect.any(Error)
    )
  })
})
