// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { useNewTabAgentMenuRows } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { Project } from '../../../shared/project-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { useDetectedAgents, type AgentDetectionTarget } from './useDetectedAgents'

const initialState = useAppStore.getInitialState()
const detectAgents = vi.fn()
const updateProject = vi.fn()

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useAppStore.getState().clearLocalDetectedAgents()
  detectAgents.mockReset().mockResolvedValue(['codex'])
  updateProject.mockReset()
  Object.assign(window, {
    api: {
      preflight: { detectAgents },
      projects: { update: updateProject },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initialState, true)
})

const localTargets: AgentDetectionTarget[] = [
  { kind: 'local' },
  { kind: 'local', worktreeId: FLOATING_TERMINAL_WORKTREE_ID, contextKey: 'host' }
]

it.each(localTargets)('restarts an invalidated first probe for $worktreeId', async (target) => {
  let finishOldProbe: (agents: string[]) => void = () => {}
  detectAgents.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishOldProbe = resolve
    })
  )
  const { result } = renderHook(() => useDetectedAgents(target))
  expect(result.current).toMatchObject({ detectedIds: null, isLoading: true })

  await act(async () => {
    useAppStore.getState().clearLocalDetectedAgents()
  })
  expect(detectAgents).toHaveBeenCalledTimes(2)
  expect(result.current).toMatchObject({ detectedIds: ['codex'], isLoading: false })

  await act(async () => {
    finishOldProbe(['claude'])
  })
  expect(result.current.detectedIds).toEqual(['codex'])
})

it('retargets a mounted first load when the project switches to WSL', async () => {
  const worktree = makeWorktree({ id: 'wt1', repoId: TEST_REPO.id, path: 'C:\\project' })
  const repos = [{ ...TEST_REPO, path: worktree.path }]
  const catalog = projectHostSetupProjectionFromRepos(repos)
  const project: Project = {
    ...catalog.projects[0],
    localWindowsRuntimePreference: { kind: 'windows-host' }
  }
  useAppStore.setState({
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: worktree.id,
    repos,
    endpointProjects: [project],
    endpointProjectHostSetups: [...catalog.setups],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    settings: {
      ...getDefaultSettings('/home/test'),
      localWindowsRuntimeDefault: { kind: 'windows-host' }
    }
  })
  let finishHostProbe: (agents: string[]) => void = () => {}
  detectAgents.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishHostProbe = resolve
    })
  )
  const { result } = renderHook(() => ({
    detection: useDetectedAgents({ kind: 'local' }),
    menu: useNewTabAgentMenuRows(worktree.id, false, { kind: 'local' })
  }))
  expect(result.current.detection.isLoading).toBe(true)
  expect(result.current.menu.state).toBe('loading')
  const preference = { kind: 'wsl', distro: 'Ubuntu' } as const
  updateProject.mockResolvedValue({ ...project, localWindowsRuntimePreference: preference })

  await act(async () => {
    await expect(
      useAppStore
        .getState()
        .updateProject(project.id, { localWindowsRuntimePreference: preference }, 'local')
    ).resolves.toBe(true)
  })
  expect(detectAgents).toHaveBeenCalledTimes(2)
  expect(detectAgents).toHaveBeenLastCalledWith(
    expect.objectContaining({
      projectRuntime: expect.objectContaining({
        runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
      })
    })
  )
  expect(result.current.detection).toMatchObject({ detectedIds: ['codex'], isLoading: false })
  expect(result.current.menu).toMatchObject({
    state: 'settled',
    rows: expect.arrayContaining([expect.objectContaining({ agent: 'codex' })])
  })

  await act(async () => {
    finishHostProbe(['claude'])
  })
  expect(result.current.detection.detectedIds).toEqual(['codex'])
})
