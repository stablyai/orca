// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getDefaultSettings } from '../../../../shared/constants'
import { getProjectHostSetupSelectionKey } from '@/lib/project-host-setup-options'
import { buildNewWorkspaceProjectOptions } from '@/lib/new-workspace-project-options'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
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

  it.each([
    { ...group, id: 'different' },
    { ...group, parentPath: null },
    { ...group, executionHostId: 'ssh:missing' }
  ])(
    'declines missing, non-folder or unreachable groups without changing selection (%j)',
    (unavailable) => {
      const { result } = renderHook(() => useReviewBaseSelectionFixture(pr))
      act(() => useAppStore.setState({ projectGroups: [unavailable] }))
      let selected = true
      act(() => {
        selected = result.current.selectAddedProjectGroup(group.id)
      })
      expect(selected).toBe(false)
      expect(result.current.selectedProjectGroupId).toBeNull()
      expect(result.current.repoId).toBe(repo.id)
      expect(result.current.linkedWorkItem).toMatchObject({ type: 'pr', number: pr.number })
    }
  )
})

it.each(['repository', 'host', 'folder'] as const)(
  'uses current offer/execution inputs through actual selection and set-location handlers (%s)',
  (mode) => {
    const first = { ...repo, id: 'a', path: '/a', upstream: { owner: 'org', repo: 'app' } }
    const second = { ...first, id: 'b', path: '/b' }
    const remote = {
      ...first,
      id: 'remote',
      path: '/remote',
      executionHostId: 'runtime:server' as const
    }
    const repos = [first, second, remote]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const projectId = projection.projects[0].id
    const hosts: ExecutionHostRegistryEntry[] = [
      { id: 'local', kind: 'local', label: 'This computer', detail: '', health: 'local' },
      { id: 'runtime:server', kind: 'runtime', label: 'Server', detail: '', health: 'available' }
    ]
    const settings = { ...getDefaultSettings(''), projectGroupingMode: mode }
    useAppStore.setState({
      repos,
      projects: [...projection.projects],
      projectHostSetups: [...projection.setups],
      settings
    })
    const state = useAppStore.getState()
    const options = buildNewWorkspaceProjectOptions({
      eligibleRepos: repos,
      projects: state.projects,
      projectHostSetups: state.projectHostSetups,
      grouping: getProjectGroupingIndexFromState(state),
      hosts
    })
    const { result } = renderHook(() => useReviewBaseSelectionFixture(pr, { hosts, projectId }))
    act(() => result.current.handleProjectChange(options[0].id))
    expect(result.current.repoId).toBe('a')
    // Explicit second checkout keeps the PR source while choosing its concrete path.
    const secondSetup = projection.setups.find((setup) => setup.repoId === 'b')!
    act(() =>
      result.current.handleProjectHostSetupChange(getProjectHostSetupSelectionKey(secondSetup))
    )
    expect(result.current.repoId).toBe('b')
    expect(result.current.selectedSetupId).toBe(secondSetup.id)
    const linked = result.current.linkedWorkItem
    // Late removal cannot replay a cached ready row.
    act(() => {
      useAppStore.setState({ repos: [first] })
      result.current.handleProjectHostSetupChange(
        getProjectHostSetupSelectionKey(
          projection.setups.find((setup) => setup.repoId === 'remote')!
        )
      )
    })
    expect(result.current.repoId).toBe('b')
    expect(result.current.linkedWorkItem).toBe(linked)
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [first],
        projects: state.projects,
        projectHostSetups: state.projectHostSetups,
        projectHostSetupId: secondSetup.id,
        projectHostSetupHostId: secondSetup.hostId
      })
    ).toMatchObject({ status: 'unavailable' })
    // The existing set-location completion publishes a concrete Repo/setup before calling this same handler.
    const located = { ...second, id: 'located', path: '/located' }
    const locatedProjection = projectHostSetupProjectionFromRepos([first, located])
    act(() => {
      useAppStore.setState({
        repos: [first, located],
        projects: [...locatedProjection.projects],
        projectHostSetups: [...locatedProjection.setups]
      })
      result.current.handleProjectHostSetupChange(
        getProjectHostSetupSelectionKey(
          locatedProjection.setups.find((setup) => setup.repoId === 'located')!
        )
      )
    })
    expect(result.current.repoId).toBe('located')
  }
)
