import { act, renderHook } from '@testing-library/react'
import { expect, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../shared/constants'
import { useDetectedAgents } from './useDetectedAgents'
import { useLocalAgentPreflightContext } from './useLocalAgentPreflightContext'
import { useNewTabAgentMenuRows } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from '@/lib/windows-terminal-capabilities'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'

export async function exerciseLocalAgentProjectGitRetarget(
  detectAgents: Mock,
  updateProject: Mock
): Promise<void> {
  const initialState = useAppStore.getState()
  const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  const apiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const originalApi = window.api
  const detectImplementation = detectAgents.getMockImplementation()
  const updateImplementation = updateProject.getMockImplementation()
  const owned: Promise<unknown>[] = []
  const replies = new Map<boolean, (ids: string[]) => void>()
  let unmount = (): void => {}
  const repo = { ...TEST_REPO, path: 'C:\\project' }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const project = projection.projects.find((row) => row.sourceRepoIds.includes(repo.id))
  const worktree = makeWorktree({ id: 'wt-git', repoId: repo.id, path: repo.path })
  const q = worktree.projectId ?? worktree.repoId
  const keyA = `${q}:wsl:Ubuntu`
  const keyB = `${keyA}:git-windows-host`
  const contextA = {
    wslDistro: 'Ubuntu',
    projectRuntime: {
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: q,
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: keyA
      }
    }
  } as const
  const contextB = {
    wslDistro: 'Ubuntu',
    projectRuntime: {
      status: 'resolved',
      runtime: { ...contextA.projectRuntime.runtime, git: 'windows-host', cacheKey: keyB }
    }
  } as const
  try {
    expect(project).toBeDefined()
    if (!project) {
      throw new Error('project projection missing')
    }
    expect(project.id).not.toBe(q)
    expect(project.sourceRepoIds).toEqual([repo.id])
    expect(projection.setups).toEqual([
      expect.objectContaining({ projectId: project.id, repoId: repo.id, hostId: 'local' })
    ])
    const preferenceA = { kind: 'wsl', distro: 'Ubuntu' } as const
    const preferenceB = { ...preferenceA, git: 'windows-host' } as const
    useAppStore.setState({
      activeRepoId: repo.id,
      activeWorktreeId: worktree.id,
      repos: [repo],
      projects: [{ ...project, localWindowsRuntimePreference: preferenceA }],
      projectHostSetups: projection.setups,
      worktreesByRepo: { [repo.id]: [worktree] },
      settings: { ...getDefaultSettings('/home/test'), agentDefaultSurface: 'terminal' }
    })
    setLocalRuntimeCapabilitiesForTests([])
    Object.assign(window, {
      api: {
        ...originalApi,
        wsl: {
          isAvailable: vi.fn<Window['api']['wsl']['isAvailable']>().mockResolvedValue(true),
          listDistros: vi.fn<Window['api']['wsl']['listDistros']>().mockResolvedValue(['Ubuntu'])
        },
        pwsh: {
          isAvailable: vi.fn<Window['api']['pwsh']['isAvailable']>().mockResolvedValue(false)
        },
        gitBash: {
          isAvailable: vi.fn<Window['api']['gitBash']['isAvailable']>().mockResolvedValue(false)
        },
        runtime: {
          getStatus: vi.fn<Window['api']['runtime']['getStatus']>().mockResolvedValue({
            runtimeId: 'local',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            hostPlatform: 'win32',
            capabilities: []
          })
        }
      }
    })
    const detect: Window['api']['preflight']['detectAgents'] = async (request) => {
      const enabled = request?.enabledOnly === true
      if (
        request?.projectRuntime?.status === 'resolved' &&
        request.projectRuntime.runtime.cacheKey === keyA
      ) {
        expect(request).toEqual(enabled ? { ...contextA, enabledOnly: true } : contextA)
        return ['codex']
      }
      expect(request).toEqual(enabled ? { ...contextB, enabledOnly: true } : contextB)
      expect(replies.has(enabled)).toBe(false)
      return new Promise<string[]>((resolve) => {
        replies.set(enabled, resolve)
      })
    }
    const update: Window['api']['projects']['update'] = async (request) => {
      expect(request).toEqual({
        projectId: project.id,
        updates: { localWindowsRuntimePreference: preferenceB }
      })
      return { ...project, localWindowsRuntimePreference: preferenceB }
    }
    detectAgents.mockImplementation(detect)
    updateProject.mockImplementation(update)
    await act(async () => {
      const load = loadWindowsTerminalCapabilities()
      owned.push(load)
      await load
      const enabled = useAppStore.getState().ensureDetectedAgents(worktree.id)
      owned.push(enabled)
      const all = useAppStore.getState().ensureAllDetectedAgents(worktree.id)
      owned.push(all)
      await Promise.all([enabled, all])
    })
    const hook = renderHook(() => ({
      context: useLocalAgentPreflightContext(worktree.id),
      enabled: useDetectedAgents({ kind: 'local', worktreeId: worktree.id }),
      all: useDetectedAgents({ kind: 'local', worktreeId: worktree.id }, 'all'),
      menu: useNewTabAgentMenuRows(worktree.id, true, { kind: 'local', worktreeId: worktree.id })
    }))
    unmount = hook.unmount
    expect(hook.result.current.context).toEqual(contextA)
    expect(hook.result.current.enabled).toMatchObject({ detectedIds: ['codex'], isLoading: false })
    expect(hook.result.current.all).toMatchObject({ detectedIds: ['codex'], isLoading: false })
    expect(hook.result.current.menu.state).toBe('settled')
    await act(async () => {
      const updateChain = useAppStore
        .getState()
        .updateProject(project.id, { localWindowsRuntimePreference: preferenceB }, 'local')
      owned.push(updateChain)
      await updateChain
      owned.push(useAppStore.getState().ensureDetectedAgents(worktree.id))
      owned.push(useAppStore.getState().ensureAllDetectedAgents(worktree.id))
    })
    expect(updateProject).toHaveBeenCalledWith({
      projectId: project.id,
      updates: { localWindowsRuntimePreference: preferenceB }
    })
    expect(replies.size).toBe(2)
    for (const key of [keyB, `${keyB}\0all-agents`]) {
      expect(useAppStore.getState().readLocalAgentInventoryByKey(key)).toEqual({
        ids: null,
        state: 'pending'
      })
    }
    expect(useAppStore.getState().localDetectedAgentIdsByContext[keyA]).toBeUndefined()
    expect(
      useAppStore.getState().localDetectedAgentIdsByContext[`${keyA}\0all-agents`]
    ).toBeUndefined()
    expect(hook.result.current.context).toEqual(contextB)
    expect(hook.result.current.enabled).toMatchObject({ detectedIds: null, isLoading: true })
    expect(hook.result.current.all).toMatchObject({ detectedIds: null, isLoading: true })
    expect(hook.result.current.menu.state).toBe('loading')
    await act(async () => {
      replies.forEach((release) => release(['codex']))
      await Promise.all(owned)
    })
    expect(hook.result.current.context).toEqual(contextB)
    expect(hook.result.current.enabled).toMatchObject({ detectedIds: ['codex'], isLoading: false })
    expect(hook.result.current.all).toMatchObject({ detectedIds: ['codex'], isLoading: false })
    expect(hook.result.current.menu).toMatchObject({
      state: 'settled',
      rows: expect.arrayContaining([expect.objectContaining({ agent: 'codex' })])
    })
    for (const key of [keyB, `${keyB}\0all-agents`]) {
      expect(useAppStore.getState().readLocalAgentInventoryByKey(key)).toEqual({
        ids: ['codex'],
        state: 'successful'
      })
      expect(useAppStore.getState().isDetectingLocalAgentsByContext[key]).toBeUndefined()
    }
    expect(useAppStore.getState().localDetectedAgentIdsByContext[keyA]).toBeUndefined()
    expect(
      useAppStore.getState().localDetectedAgentIdsByContext[`${keyA}\0all-agents`]
    ).toBeUndefined()
  } finally {
    unmount()
    await act(async () => {
      replies.forEach((release) => release(['codex']))
      await Promise.allSettled(owned)
    })
    useAppStore.getState().clearLocalDetectedAgents()
    Object.defineProperty(
      window,
      'api',
      apiDescriptor ?? { value: originalApi, configurable: true, writable: true, enumerable: true }
    )
    detectAgents.mockReset()
    updateProject.mockReset()
    if (detectImplementation) {
      detectAgents.mockImplementation(detectImplementation)
    }
    if (updateImplementation) {
      updateProject.mockImplementation(updateImplementation)
    }
    resetWindowsTerminalCapabilitiesForTests()
    setLocalRuntimeCapabilitiesForTests(capabilities)
    useAppStore.setState(initialState, true)
  }
}
