// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { MultiRepoWorkspaceError } from '../../../../shared/multi-repo-workspace'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { loadLastMultiRepoSet } from './multi-repo-last-set-storage'
import { useMultiRepoComposer, type UseMultiRepoComposerInput } from './use-multi-repo-composer'

const mocks = vi.hoisted(() => ({ activate: vi.fn() }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: mocks.activate }))
vi.mock('@/runtime/runtime-client-target', () => ({
  ipcOrRuntimeTargetForHostId: () => ({ kind: 'local' })
}))
vi.mock('@/store/slices/multi-repo-workspace/multi-repo-workspace-capability', () => ({
  multiRepoWorkspaceSupportedOnTarget: () => Promise.resolve(true)
}))

function setup(projectId: string, patch: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: `${projectId}-${patch.hostId ?? 'local'}`,
    projectId,
    hostId: 'local',
    repoId: `repo-${projectId}`,
    path: `/code/${projectId}`,
    displayName: projectId,
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

function option(projectId: string): NewWorkspaceProjectOption {
  return {
    kind: 'project',
    id: projectId,
    projectId,
    displayName: projectId,
    badgeColor: '#000',
    detail: ''
  }
}

const create = vi.fn()

function input(patch: Partial<UseMultiRepoComposerInput> = {}): UseMultiRepoComposerInput {
  return {
    primaryProjectId: 'api',
    projectOptions: [option('api'), option('web'), option('infra')],
    projectHostSetupOptions: [],
    hostId: 'local',
    name: 'checkout-flow',
    quickAgent: null,
    onPrimaryProjectChange: vi.fn(),
    onCreated: vi.fn(),
    ...patch
  }
}

beforeEach(() => {
  localStorage.clear()
  create.mockReset()
  mocks.activate.mockReset()
  useAppStore.setState({
    repos: [],
    projects: [],
    projectHostSetups: [
      setup('api'),
      setup('web'),
      setup('infra', { hostId: 'runtime:a' }),
      setup('web', { hostId: 'runtime:a' })
    ],
    createMultiRepoWorkspace: create
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMultiRepoComposer', () => {
  it('stays inactive with one project and activates once a second is added', async () => {
    const { result } = renderHook(() => useMultiRepoComposer(input()))
    expect(result.current.active).toBe(false)
    act(() => result.current.toggleProject('web'))
    expect(result.current.active).toBe(true)
    expect(result.current.selectedProjectIds).toEqual(['api', 'web'])
    expect(result.current.primaryActionLabel).toBe('Create in 2 projects')
    await waitFor(() => expect(result.current.supported).toBe(true))
  })

  it('keeps a project without a setup on the new host, blocks Create and says why', () => {
    const { result, rerender } = renderHook((props) => useMultiRepoComposer(props), {
      initialProps: input()
    })
    act(() => result.current.toggleProject('web'))
    rerender(input({ hostId: 'runtime:a' }))
    expect(result.current.selectedProjectIds).toEqual(['api', 'web'])
    expect(result.current.blockedCount).toBe(1)
    expect(result.current.blockedReason).toBe('Remove 1 project or switch host')
  })

  it('keeps a chip for a selected project the picker no longer lists, so the blocked count matches', () => {
    const { result } = renderHook(() =>
      useMultiRepoComposer(
        input({ hostId: 'runtime:a', projectOptions: [option('api'), option('web')] })
      )
    )
    act(() => result.current.toggleProject('gone'))
    expect(result.current.blockedCount).toBeGreaterThan(0)
    expect(result.current.selectedProjects.map((project) => project.projectId)).toEqual([
      'api',
      'gone'
    ])
    expect(result.current.selectedProjects).toHaveLength(result.current.selectedProjectIds.length)
  })

  it('labels the action by the projects that can be created, not the blocked ones', () => {
    const { result, rerender } = renderHook((props) => useMultiRepoComposer(props), {
      initialProps: input()
    })
    act(() => result.current.toggleProject('web'))
    expect(result.current.primaryActionLabel).toBe('Create in 2 projects')
    rerender(input({ hostId: 'runtime:a' }))
    expect(result.current.blockedCount).toBe(1)
    expect(result.current.creatableCount).toBe(1)
    expect(result.current.primaryActionLabel).toBe('Create workspace')
  })

  it('creates with the repo ids of the resolved setups in selection order and remembers the set', async () => {
    const onCreated = vi.fn()
    create.mockResolvedValue({ id: 'folder-1' })
    const { result } = renderHook(() =>
      useMultiRepoComposer(input({ onCreated, quickAgent: 'claude' }))
    )
    act(() => result.current.toggleProject('web'))
    await act(() => result.current.submit())
    expect(create).toHaveBeenCalledWith({
      name: 'checkout-flow',
      members: [{ repoId: 'repo-api' }, { repoId: 'repo-web' }],
      clientMutationId: expect.any(String),
      createdWithAgent: 'claude'
    })
    expect(mocks.activate).toHaveBeenCalledWith('folder:folder-1', {
      navigationIntent: 'user-open'
    })
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(loadLastMultiRepoSet()).toEqual({ projectIds: ['api', 'web'], singleCreatesSince: 0 })
  })

  it('keeps the remembered set but neither activates nor closes when the dialog was dismissed mid-create', async () => {
    const onCreated = vi.fn()
    create.mockResolvedValue({ id: 'folder-1' })
    const { result } = renderHook(() =>
      useMultiRepoComposer(input({ onCreated, isSubmissionCancelled: () => true }))
    )
    act(() => result.current.toggleProject('web'))
    await act(() => result.current.submit())
    expect(create).toHaveBeenCalledTimes(1)
    expect(loadLastMultiRepoSet()).toEqual({ projectIds: ['api', 'web'], singleCreatesSince: 0 })
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('offers Use host only where the primary project has a ready Run on option', () => {
    const onProjectHostSetupChange = vi.fn()
    const { result } = renderHook(() =>
      useMultiRepoComposer(
        input({
          onProjectHostSetupChange,
          projectHostSetupOptions: [
            {
              id: 'api-runtime:a',
              kind: 'ready',
              projectId: 'api',
              hostId: 'runtime:a',
              repoId: 'repo-api',
              label: 'Server',
              detail: 'api',
              path: '/srv/api'
            }
          ]
        })
      )
    )
    expect(result.current.canUseHost('runtime:a')).toBe(true)
    expect(result.current.canUseHost('runtime:b')).toBe(false)
    act(() => result.current.useHost('runtime:a'))
    expect(onProjectHostSetupChange).toHaveBeenCalledWith('api-runtime:a')
  })

  it('shows a persistent mixed-hosts error and keeps the selection when the host refuses', async () => {
    create.mockRejectedValue(
      new MultiRepoWorkspaceError('multi_repo_mixed_hosts', 'All projects must live on this host.')
    )
    const onCreated = vi.fn()
    const { result } = renderHook(() => useMultiRepoComposer(input({ onCreated })))
    act(() => result.current.toggleProject('web'))
    await act(() => result.current.submit())
    expect(result.current.mixedHostsError).toBe(true)
    expect(result.current.createError).toBeNull()
    expect(result.current.selectedProjectIds).toEqual(['api', 'web'])
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('does not send while a selected project has no setup on the host', async () => {
    const { result } = renderHook(() => useMultiRepoComposer(input({ hostId: 'runtime:a' })))
    act(() => result.current.toggleProject('web'))
    await act(() => result.current.submit())
    expect(create).not.toHaveBeenCalled()
  })

  it('hands the primary role to the next project when the first chip is removed', () => {
    const onPrimaryProjectChange = vi.fn()
    const { result } = renderHook(() => useMultiRepoComposer(input({ onPrimaryProjectChange })))
    act(() => result.current.toggleProject('web'))
    act(() => result.current.removeProject('api'))
    expect(onPrimaryProjectChange).toHaveBeenCalledWith('web')
  })

  it('offers Same as last time only for one project whose whole set resolves', () => {
    localStorage.setItem(
      'orca.new-workspace.last-multi-repo-set.v1',
      JSON.stringify({ projectIds: ['api', 'web'], singleCreatesSince: 0 })
    )
    const { result } = renderHook(() => useMultiRepoComposer(input()))
    expect(result.current.sameAsLast).toEqual(['api', 'web'])
    expect(result.current.sameAsLastLabel).toBe('api, web')
  })
})
