// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectGroupDialogs, type ProjectGroupDialogs } from './use-project-group-dialogs'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

const mocks = vi.hoisted(() => ({
  moveProjectToGroup: vi.fn(),
  createProjectGroup: vi.fn(),
  updateProjectGroup: vi.fn(),
  deleteProjectGroupWithContainedProjects: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      moveProjectToGroup: mocks.moveProjectToGroup,
      createProjectGroup: mocks.createProjectGroup,
      updateProjectGroup: mocks.updateProjectGroup,
      deleteProjectGroupWithContainedProjects: mocks.deleteProjectGroupWithContainedProjects
    })
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

const remoteGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Projects',
  parentPath: '/srv/projects',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  executionHostId: 'runtime:env-1',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

let latest: ProjectGroupDialogs | null = null
const roots: Root[] = []

function HookProbe(): null {
  latest = useProjectGroupDialogs({
    repos: [],
    repoMap: new Map(),
    projectGroups: [remoteGroup]
  })
  return null
}

async function renderHookProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateProjectGroup.mockResolvedValue(true)
  mocks.deleteProjectGroupWithContainedProjects.mockResolvedValue({
    status: 'deleted-group',
    groupId: remoteGroup.id,
    requestedProjectIds: [],
    removedProjectIds: [],
    failedProjectRemovals: []
  })
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  latest = null
})

describe('project group dialogs carry the owner host', () => {
  it('renames through the host that owns the group row', async () => {
    await renderHookProbe()
    await act(async () => {
      latest!.handleRenameProjectGroup(remoteGroup.id, remoteGroup.name, 'runtime:env-1')
    })
    await act(async () => {
      await latest!.handleSubmitProjectGroupName('Renamed')
    })

    expect(mocks.updateProjectGroup).toHaveBeenCalledWith(
      remoteGroup.id,
      { name: 'Renamed' },
      { hostId: 'runtime:env-1' }
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('surfaces an unconfirmed-rename toast when the owner host does not answer', async () => {
    mocks.updateProjectGroup.mockResolvedValue(false)
    await renderHookProbe()
    await act(async () => {
      latest!.handleRenameProjectGroup(remoteGroup.id, remoteGroup.name, 'runtime:env-1')
    })
    await act(async () => {
      await latest!.handleSubmitProjectGroupName('Renamed')
    })

    expect(mocks.toastError).toHaveBeenCalledWith('Failed to rename group', {
      description:
        "Orca could not confirm the new name with the group's host. Recheck the group after reconnecting."
    })
  })

  it('deletes through the host that owns the group row', async () => {
    await renderHookProbe()
    await act(async () => {
      latest!.handleDeleteProjectGroup(remoteGroup.id, remoteGroup.name, 'runtime:env-1')
    })
    await act(async () => {
      await latest!.handleConfirmDeleteProjectGroup()
    })

    expect(mocks.deleteProjectGroupWithContainedProjects).toHaveBeenCalledWith(remoteGroup.id, {
      removeContainedProjects: false,
      hostId: 'runtime:env-1'
    })
  })
})
