// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { useNewTabAgentMenuRows } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  useSourceControlActionAgent,
  useSourceControlActionAgentInventory
} from '@/components/settings/use-source-control-action-agent'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { useHostStructuredAgentsSync } from '@/runtime/host-structured-agents-sync'
import {
  readHostStructuredAgentsForRuntime,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { Project } from '../../../shared/project-types'
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
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
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
  const project: Project = {
    id: TEST_REPO.id,
    displayName: TEST_REPO.displayName,
    badgeColor: TEST_REPO.badgeColor,
    sourceRepoIds: [TEST_REPO.id],
    createdAt: 0,
    updatedAt: 0,
    localWindowsRuntimePreference: { kind: 'windows-host' }
  }
  const worktree = makeWorktree({ id: 'wt1', repoId: TEST_REPO.id, path: 'C:\\project' })
  useAppStore.setState({
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: worktree.id,
    repos: [{ ...TEST_REPO, path: worktree.path }],
    projects: [project],
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

it('recovers mounted native consumers after availability changes alongside WSL launch and Settings inventories', async () => {
  const project: Project = {
    id: TEST_REPO.id,
    displayName: TEST_REPO.displayName,
    badgeColor: TEST_REPO.badgeColor,
    sourceRepoIds: [TEST_REPO.id],
    createdAt: 0,
    updatedAt: 0,
    localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
  }
  const settings = {
    ...getDefaultSettings('/home/test'),
    nativeChatProviders: EVERY_AGENT_CHAT,
    localWindowsRuntimeDefault: { kind: 'windows-host' } as const
  }
  useAppStore.setState({
    activeRepoId: TEST_REPO.id,
    repos: [{ ...TEST_REPO, path: 'C:\\project' }],
    projects: [project],
    settings
  })
  setLocalRuntimeCapabilitiesForTests([
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ])
  Object.assign(window.api, {
    runtime: {
      call: vi.fn(async () => ({
        id: 'registered-agents',
        ok: true,
        result: { agents: [{ agent: 'pi', capabilities: {} }] }
      }))
    }
  })
  let nativeAgents = ['pi', 'codex']
  detectAgents.mockImplementation((context) =>
    Promise.resolve(
      context?.projectRuntime?.runtime.kind === 'wsl'
        ? context.enabledOnly
          ? ['claude']
          : ['claude', 'kiro']
        : nativeAgents
    )
  )
  const { result } = renderHook(() => {
    useHostStructuredAgentsSync()
    useSourceControlActionAgentInventory()
    return {
      native: useSourceControlActionAgent('pi', 'codex'),
      workspace: useDetectedAgents({ kind: 'local' }),
      settings: useDetectedAgents({ kind: 'local' }, 'all')
    }
  })
  await act(async () => {})
  expect(result.current.native).toMatchObject({ status: 'ready', agent: 'pi' })
  expect(readHostStructuredAgentsForRuntime('local', null)?.map((row) => row.agent)).toEqual(['pi'])

  nativeAgents = ['codex']
  await act(async () => {
    useAppStore.setState({ settings: { ...settings, disabledTuiAgents: ['pi', 'kiro'] } })
  })
  expect(readNativeDetectedAgents(useAppStore.getState())).toEqual(['codex'])
  expect(result.current.native).toMatchObject({ status: 'ready', agent: 'codex' })
  expect(result.current.workspace).toMatchObject({ detectedIds: ['claude'], isLoading: false })
  expect(result.current.settings).toMatchObject({
    detectedIds: ['claude', 'kiro'],
    isLoading: false
  })
  const probesAfterDisable = detectAgents.mock.calls.length
  await act(async () => {
    useAppStore.setState({ settings: { ...settings, disabledTuiAgents: ['kiro', 'pi'] } })
  })
  expect(detectAgents).toHaveBeenCalledTimes(probesAfterDisable)

  nativeAgents = ['pi', 'codex']
  await act(async () => {
    useAppStore.setState({ settings: { ...settings, disabledTuiAgents: ['kiro'] } })
  })
  expect(readNativeDetectedAgents(useAppStore.getState())).toEqual(['pi', 'codex'])
  expect(result.current.native).toMatchObject({ status: 'ready', agent: 'pi' })
  expect(result.current.workspace).toMatchObject({ detectedIds: ['claude'], isLoading: false })
  expect(result.current.settings).toMatchObject({
    detectedIds: ['claude', 'kiro'],
    isLoading: false
  })
  expect(useAppStore.getState().detectedAgentIds).toEqual(['claude'])
  expect(useAppStore.getState().isDetectingLocalAgentsByContext).toEqual({})
  expect(useAppStore.getState().isRefreshingLocalAgentsByContext).toEqual({})
  expect(detectAgents.mock.calls.filter(([context]) => !context?.projectRuntime)).toEqual([
    [{ enabledOnly: true }],
    [{ enabledOnly: true }],
    [{ enabledOnly: true }]
  ])
})
