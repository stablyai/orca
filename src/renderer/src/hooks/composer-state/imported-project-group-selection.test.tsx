// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { pr, repo, useReviewBaseSelectionFixture } from './composer-review-base-test-fixture'

const originalState = useAppStore.getState()
const group: ProjectGroup = {
  id: 'just-imported',
  name: 'Imported group',
  parentPath: '/imported',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
})

describe('imported group composer selection', () => {
  it('selects a group created after render through the same reset path as the picker', () => {
    const { result } = renderHook(() => useReviewBaseSelectionFixture(pr))
    const importedRepo = {
      ...repo,
      id: 'imported-repo',
      path: '/imported/app',
      projectGroupId: group.id
    }
    act(() => useAppStore.setState({ projectGroups: [group], repos: [importedRepo] }))
    let selected = false
    act(() => {
      selected = result.current.selectAddedProjectGroup(group.id)
    })
    expect(selected).toBe(true)
    expect(result.current.selectedProjectGroupId).toBe(group.id)
    expect(result.current.repoId).toBe(importedRepo.id)
    expect(result.current.linkedWorkItem).toBeNull()
    expect(result.current.baseBranch).toBeUndefined()
    expect(result.current.branchNameOverride).toBeUndefined()
    expect(result.current.pushTarget).toBeUndefined()
  })
})
