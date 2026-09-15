import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  moveProjectToGroup: vi.fn(),
  updateProjectGroup: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: mocks.getState
  }
}))

import {
  assignAddedRepoToTargetClient,
  nestImportedGroupUnderTargetClient,
  readTargetProjectGroupIdFromModalData
} from './assign-added-repo-to-target-client'

describe('assign-added-repo-to-target-client', () => {
  beforeEach(() => {
    mocks.getState.mockReset()
    mocks.moveProjectToGroup.mockReset()
    mocks.updateProjectGroup.mockReset()
    mocks.moveProjectToGroup.mockResolvedValue(true)
    mocks.updateProjectGroup.mockResolvedValue(true)
  })

  it('reads a non-empty targetProjectGroupId from modal data', () => {
    expect(readTargetProjectGroupIdFromModalData({ targetProjectGroupId: 'client-1' })).toBe(
      'client-1'
    )
    expect(readTargetProjectGroupIdFromModalData({ targetProjectGroupId: '' })).toBeNull()
    expect(readTargetProjectGroupIdFromModalData({})).toBeNull()
  })

  it('moves an ungrouped repo into the target client', async () => {
    mocks.getState.mockReturnValue({
      modalData: { targetProjectGroupId: 'client-1' },
      projectGroups: [{ id: 'client-1' }],
      repos: [{ id: 'repo-1', projectGroupId: null }],
      moveProjectToGroup: mocks.moveProjectToGroup,
      updateProjectGroup: mocks.updateProjectGroup
    })

    await assignAddedRepoToTargetClient('repo-1')

    expect(mocks.moveProjectToGroup).toHaveBeenCalledWith('repo-1', 'client-1')
  })

  it('skips repos that already belong to a group', async () => {
    mocks.getState.mockReturnValue({
      modalData: { targetProjectGroupId: 'client-1' },
      projectGroups: [{ id: 'client-1' }],
      repos: [{ id: 'repo-1', projectGroupId: 'nested-group' }],
      moveProjectToGroup: mocks.moveProjectToGroup,
      updateProjectGroup: mocks.updateProjectGroup
    })

    await assignAddedRepoToTargetClient('repo-1')

    expect(mocks.moveProjectToGroup).not.toHaveBeenCalled()
  })

  it('nests an imported group under the target client', async () => {
    mocks.getState.mockReturnValue({
      modalData: { targetProjectGroupId: 'client-1' },
      projectGroups: [{ id: 'client-1' }, { id: 'imported' }],
      repos: [],
      moveProjectToGroup: mocks.moveProjectToGroup,
      updateProjectGroup: mocks.updateProjectGroup
    })

    await nestImportedGroupUnderTargetClient('imported')

    expect(mocks.updateProjectGroup).toHaveBeenCalledWith('imported', {
      parentGroupId: 'client-1'
    })
  })

  it('routes nested import assignment through group or project paths', async () => {
    const { assignNestedImportToTargetClient } =
      await import('./assign-added-repo-to-target-client')

    mocks.getState.mockReturnValue({
      modalData: { targetProjectGroupId: 'client-1' },
      projectGroups: [{ id: 'client-1' }, { id: 'imported' }],
      repos: [{ id: 'repo-1', projectGroupId: null }],
      moveProjectToGroup: mocks.moveProjectToGroup,
      updateProjectGroup: mocks.updateProjectGroup
    })

    await assignNestedImportToTargetClient({ groupId: 'imported', projectIds: ['repo-1'] })
    expect(mocks.updateProjectGroup).toHaveBeenCalledWith('imported', {
      parentGroupId: 'client-1'
    })
    expect(mocks.moveProjectToGroup).not.toHaveBeenCalled()

    mocks.updateProjectGroup.mockClear()
    await assignNestedImportToTargetClient({ projectIds: ['repo-1'] })
    expect(mocks.moveProjectToGroup).toHaveBeenCalledWith('repo-1', 'client-1')
  })
})
