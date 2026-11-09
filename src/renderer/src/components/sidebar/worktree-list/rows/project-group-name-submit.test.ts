import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  resolveSubgroupCreationHostId,
  submitProjectGroupNameDialog
} from './project-group-name-submit'

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('resolveSubgroupCreationHostId', () => {
  it('returns the owning runtime host of the parent group', () => {
    const groups = [makeGroup('parent-1', { executionHostId: 'runtime:env-1' })]

    expect(resolveSubgroupCreationHostId(groups, 'parent-1')).toBe('runtime:env-1')
  })

  it('preserves ssh:<target> ownership when resolving subgroup creation host for an SSH parent group', () => {
    const groups = [makeGroup('ssh-parent', { connectionId: 'box-1' })]

    expect(resolveSubgroupCreationHostId(groups, 'ssh-parent')).toBe('ssh:box-1')
  })

  it('returns null when a colliding group id has no unambiguous owner host', () => {
    const groups = [
      makeGroup('shared', { executionHostId: 'local' }),
      makeGroup('shared', { executionHostId: 'runtime:env-1' })
    ]

    expect(resolveSubgroupCreationHostId(groups, 'shared')).toBeNull()
  })
})

describe('submitProjectGroupNameDialog', () => {
  it('creates a subgroup under parentGroupId and expands the parent group header', async () => {
    const createProjectGroup = vi
      .fn()
      .mockResolvedValue(makeGroup('sub-1', { parentGroupId: 'parent-1' }))
    const onExpandGroupKey = vi.fn()
    const onError = vi.fn()

    await submitProjectGroupNameDialog(
      {
        type: 'create-empty',
        hostId: 'runtime:env-1',
        parentGroupId: 'parent-1',
        parentGroupName: 'Parent'
      },
      'Backend',
      {
        createProjectGroup,
        moveProjectToGroup: vi.fn(),
        updateProjectGroup: vi.fn(),
        onExpandGroupKey,
        onError
      }
    )

    expect(createProjectGroup).toHaveBeenCalledWith(
      'Backend',
      'runtime:env-1',
      expect.objectContaining({
        parentGroupId: 'parent-1'
      })
    )
    expect(onExpandGroupKey).toHaveBeenCalledWith('project-group:parent-1')
    expect(onError).not.toHaveBeenCalled()
  })

  it('suppresses generic create-failed error when createProjectGroup reports parent-move rejection', async () => {
    const createProjectGroup = vi.fn().mockImplementation(async (_name, _hostId, options) => {
      options?.onParentMoveRejected?.()
      return null
    })
    const onError = vi.fn()

    await expect(
      submitProjectGroupNameDialog(
        {
          type: 'create-empty',
          hostId: 'runtime:env-1',
          parentGroupId: 'parent-1',
          parentGroupName: 'Parent'
        },
        'Backend',
        {
          createProjectGroup,
          moveProjectToGroup: vi.fn(),
          updateProjectGroup: vi.fn(),
          onError
        }
      )
    ).rejects.toThrow('project_group_create_failed')

    expect(onError).not.toHaveBeenCalled()
  })

  it('reports creation failure and throws so the dialog stays open when createProjectGroup returns null', async () => {
    const createProjectGroup = vi.fn().mockResolvedValue(null)
    const onError = vi.fn()

    await expect(
      submitProjectGroupNameDialog(
        {
          type: 'create-empty',
          hostId: 'local',
          parentGroupId: null
        },
        'Frontend',
        {
          createProjectGroup,
          moveProjectToGroup: vi.fn(),
          updateProjectGroup: vi.fn(),
          onError
        }
      )
    ).rejects.toThrow('project_group_create_failed')

    expect(onError).toHaveBeenCalledWith('create-failed')
  })

  it('reports rename failure and throws so the dialog stays open when updateProjectGroup returns false', async () => {
    const updateProjectGroup = vi.fn().mockResolvedValue(false)
    const onError = vi.fn()

    await expect(
      submitProjectGroupNameDialog(
        {
          type: 'rename',
          groupId: 'group-1',
          currentName: 'Old Name',
          hostId: 'local'
        },
        'New Name',
        {
          createProjectGroup: vi.fn(),
          moveProjectToGroup: vi.fn(),
          updateProjectGroup,
          onError
        }
      )
    ).rejects.toThrow('project_group_rename_failed')

    expect(onError).toHaveBeenCalledWith('rename-failed')
  })

  it('resolves without duplicating group creation when create-from-repo group succeeds but moveProjectToGroup fails', async () => {
    const createProjectGroup = vi.fn().mockResolvedValue(makeGroup('new-g'))
    const moveProjectToGroup = vi.fn().mockResolvedValue(false)
    const onError = vi.fn()

    await expect(
      submitProjectGroupNameDialog(
        {
          type: 'create-from-repo',
          repo: {
            id: 'repo-1',
            path: '/repo-1',
            displayName: 'Repo 1',
            badgeColor: '#000',
            addedAt: 1,
            executionHostId: 'local'
          }
        },
        'New Group',
        {
          createProjectGroup,
          moveProjectToGroup,
          updateProjectGroup: vi.fn(),
          onError
        }
      )
    ).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledWith('move-failed')
  })
})
