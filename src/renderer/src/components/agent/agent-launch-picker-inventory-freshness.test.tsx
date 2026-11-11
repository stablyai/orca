// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as REGISTERED } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeDetectedResult } from '@/store/slices/worktrees/listing/worktrees-detected-listing-fixtures'
import * as discovery from '../native-chat/session/options/catalog/native-chat-session-option-discovery'
import { createAntigravityTerminalModelDemand } from '../native-chat/session/options/terminal/antigravity-terminal-model-observation'
import { useNativeChatSessionOptions } from '../native-chat/session/options/terminal/use-native-chat-session-options'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
const transport = vi.hoisted(() => ({ call: vi.fn(), rpc: vi.fn(), defaults: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: transport.call
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: transport.rpc }))
vi.mock('@/runtime/agent-launch-settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchDefaults: transport.defaults
}))
const initial = useAppStore.getState()
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  resetHostStructuredAgentsForTests()
  vi.resetAllMocks()
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})
const detection: UseDetectedAgentsResult = {
  detectedIds: ['codex'],
  isLoading: false,
  isRefreshing: false,
  detectionFailed: false,
  needsServerUpdate: false,
  refresh: async () => ['codex']
}

it('reads a paired unknown-platform catalog before launch defaults and keeps it after defaults fail', async () => {
  useAppStore.setState({ settings: getDefaultSettings('/synthetic') })
  transport.rpc.mockResolvedValue({ agents: [] })
  await loadHostStructuredAgents('runtime:unknown-platform', [REGISTERED], 'server-runtime')
  const defaults = Promise.withResolvers<never>()
  transport.defaults.mockReturnValue(defaults.promise)
  transport.call.mockResolvedValue({
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'server-only', label: 'Server', isDefault: false, efforts: [] }]
  })
  const model: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [{ agent: 'codex', kind: 'cli' }],
    detection,
    pickerContext: {
      workspace: {
        kind: 'git-worktree',
        repoId: 'future',
        executionHostId: 'runtime:unknown-platform'
      },
      executionHostId: 'runtime:unknown-platform',
      runtimeId: 'server-runtime',
      settings: null,
      key: 'unknown-platform'
    }
  }
  const hook = renderHook(() => useAgentLaunchPickerInventory(undefined, model, true))
  await waitFor(() =>
    expect(hook.result.current[0]).toMatchObject({
      catalogRead: 'settled',
      defaultsPending: true,
      catalog: { models: [{ id: 'server-only' }] }
    })
  )
  await act(async () => {
    defaults.reject(new Error('defaults offline'))
  })
  expect(hook.result.current[0]).toMatchObject({
    catalogRead: 'settled',
    catalog: { models: [{ id: 'server-only' }] }
  })
})

it('reads the structured host list for a local UNC workspace instead of gating on its terminal route', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: { get: () => ({ platform: 'win32' }) } }
  })
  useAppStore.setState({
    settings: getDefaultSettings('/synthetic'),
    repos: [
      {
        ...TEST_REPO,
        id: 'unc',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\app',
        executionHostId: 'local'
      }
    ]
  })
  transport.call.mockResolvedValue({
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'host-only', label: 'Host', isDefault: false, efforts: [] }]
  })
  const model: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [{ agent: 'codex', kind: 'cli' }],
    detection,
    pickerContext: {
      workspace: { kind: 'git-worktree', repoId: 'unc' },
      executionHostId: 'local',
      settings: {},
      key: 'local-unc'
    }
  }
  const hook = renderHook(() => useAgentLaunchPickerInventory(undefined, model, true))
  await waitFor(() =>
    expect(hook.result.current[0]).toMatchObject({
      catalogRead: 'settled',
      catalog: { models: [{ id: 'host-only' }] }
    })
  )
})

it('reloads paired launch defaults when reopening while the old catalog request drains', async () => {
  useAppStore.setState({ settings: getDefaultSettings('/synthetic') })
  const catalog = Promise.withResolvers<never>()
  const admitted = Promise.withResolvers<void>()
  const defaults = Promise.withResolvers<{
    settings: { agentDefaultArgs: { codex: string } }
    structuredKnown: boolean
  }>()
  transport.call.mockImplementation(() => {
    admitted.resolve()
    return catalog.promise
  })
  transport.defaults.mockReturnValueOnce(defaults.promise).mockResolvedValue({
    settings: {
      agentDefaultArgs: { codex: '--add-dir fresh' },
      nativeChatSessionOptions: {
        codex: { model: 'fresh-default', valuesByModel: { 'fresh-default': { effort: 'high' } } }
      }
    },
    structuredKnown: true
  })
  const model: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [{ agent: 'codex', kind: 'cli' }],
    detection,
    pickerContext: {
      workspace: { kind: 'floating', executionHostId: 'runtime:defaults-reopen' },
      executionHostId: 'runtime:defaults-reopen',
      runtimeId: 'defaults-server',
      settings: null,
      key: 'defaults-reopen'
    }
  }
  const hook = renderHook(({ open }) => useAgentLaunchPickerInventory(undefined, model, open), {
    initialProps: { open: true }
  })
  await act(async () => admitted.promise)
  hook.rerender({ open: false })
  await act(async () => {
    defaults.resolve({
      settings: { agentDefaultArgs: { codex: '--add-dir old' } },
      structuredKnown: true
    })
  })
  hook.rerender({ open: true })
  try {
    await waitFor(() =>
      expect(hook.result.current[0]).toMatchObject({
        defaultsPending: false,
        arguments: '--add-dir fresh',
        structured: { model: 'fresh-default', options: { effort: 'high' } }
      })
    )
  } finally {
    hook.unmount()
    await act(async () => catalog.reject(new Error('closed catalog')))
  }
})

it('forwards a prospective paired repo and explicit launch cwd to terminal discovery', async () => {
  useAppStore.setState({
    settings: getDefaultSettings('/synthetic'),
    repos: [
      {
        ...TEST_REPO,
        id: 'agy-repo',
        path: '/remote/repo',
        executionHostId: 'runtime:agy-destination'
      }
    ]
  })
  transport.defaults.mockResolvedValue(undefined)
  transport.rpc.mockResolvedValue({
    success: true,
    catalogOrigin: 'probe',
    models: [
      { id: 'gemini-3.8-flash-low', label: 'Flash (Low)' },
      { id: 'gemini-3.8-flash-high', label: 'Flash (High)' }
    ]
  })
  const model: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [{ agent: 'antigravity', kind: 'cli' }],
    detection: { ...detection, detectedIds: ['antigravity'] },
    pickerContext: {
      workspace: {
        kind: 'git-worktree',
        repoId: 'agy-repo',
        executionHostId: 'runtime:agy-destination'
      },
      launchCwd: '/remote/requested-cwd',
      executionHostId: 'runtime:agy-destination',
      settings: {},
      key: 'agy-prospective'
    }
  }
  const hook = renderHook(() => useAgentLaunchPickerInventory(undefined, model, true))
  await waitFor(() => expect(hook.result.current[0].terminalCatalogRead).toBe('settled'))
  expect(transport.rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'agy-destination' },
    'agent.discoverTerminalModels',
    {
      agentId: 'antigravity',
      repo: 'agy-repo',
      repoHostId: 'runtime:agy-destination',
      cwd: '/remote/requested-cwd'
    },
    expect.anything()
  )
  expect(hook.result.current[0].terminalCatalog).toMatchObject({
    models: [{ id: 'gemini-3.8-flash' }]
  })
})

it('clears an open terminal catalog when only detected ownership changes and fences the old answer', async () => {
  const id = 'repo1::/repo1/worktree'
  const row = makeWorktree({ id, repoId: 'repo1', path: '/repo1/worktree', hostId: 'local' })
  useAppStore.setState({
    settings: getDefaultSettings('/synthetic'),
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [row] },
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [id]: [makeTab({ id: 'owner-tab', worktreeId: id })] },
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironmentCatalogHydrated: true
  })
  const old = Promise.withResolvers<unknown>()
  const localRead = vi.fn().mockReturnValue(old.promise)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { git: { discoverTerminalModels: localRead } }
  })
  transport.rpc.mockResolvedValue({
    success: true,
    catalogOrigin: 'probe',
    models: [{ id: 'remote-only', label: 'Remote' }]
  })
  const publish = vi.fn()
  const demand = createAntigravityTerminalModelDemand('owner-tab')
  const stop = demand.demand(publish)
  try {
    expect(localRead).toHaveBeenCalledTimes(1)
    act(() => {
      useAppStore.setState({
        detectedWorktreesByRepo: {
          repo1: makeDetectedResult('repo1', [
            { ...row, hostId: 'runtime:destination', runtimeOwnerEnvironmentId: 'destination' }
          ])
        }
      })
    })
    expect(discovery.resolveNativeChatModelDiscoveryContext('owner-tab')).toBeNull()
    expect(publish).toHaveBeenLastCalledWith([])
    act(() => {
      useAppStore.setState({
        activeWorktreeId: id,
        activeWorkspaceExecutionHostId: 'runtime:destination'
      })
    })
    await waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'remote-only' })])
    )
    expect(transport.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'destination' },
      'agent.discoverTerminalModels',
      { agentId: 'antigravity', worktree: `id:${id}` },
      expect.anything()
    )
    await act(async () =>
      old.resolve({
        success: true,
        catalogOrigin: 'probe',
        models: [{ id: 'stale-local', label: 'Stale' }]
      })
    )
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'remote-only' })])
  } finally {
    stop()
    demand.dispose()
  }
})

it.each([3, 30])(
  'bounds repeated status updates across %i terminal consumers without rendering unaffected panes',
  async (count) => {
    const ids = [
      ...Array.from({ length: count - 1 }, (_, index) => `repo1::/repo1/pane-${index}`),
      'remote::/remote/one'
    ]
    useAppStore.setState({
      settings: getDefaultSettings('/synthetic'),
      repos: [TEST_REPO, { ...TEST_REPO, id: 'remote', executionHostId: 'runtime:other' }],
      worktreesByRepo: {
        repo1: ids.slice(0, -1).map((id) => makeWorktree({ id, repoId: 'repo1', hostId: 'local' })),
        remote: [
          makeWorktree({
            id: ids[count - 1],
            repoId: 'remote',
            hostId: 'runtime:other',
            runtimeOwnerEnvironmentId: 'other'
          })
        ]
      },
      detectedWorktreesByRepo: {},
      tabsByWorktree: Object.fromEntries(
        ids.map((id, index) => [id, [makeTab({ id: `perf-tab-${index}`, worktreeId: id })]])
      ),
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      runtimeEnvironmentCatalogHydrated: true,
      agentStatusByPaneKey: {}
    })
    const localRead = vi.fn().mockResolvedValue({ success: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { git: { discoverTerminalModels: localRead } }
    })
    const resolve = vi.spyOn(discovery, 'resolveNativeChatModelDiscoveryContext')
    const renders = ids.map(() => 0)
    const dispatchCommand = vi.fn()
    const panes = ids.map((_, index) =>
      renderHook(() => {
        renders[index]++
        return useNativeChatSessionOptions({
          agent: 'antigravity',
          terminalTabId: `perf-tab-${index}`,
          targetPtyId: `perf-pty-${index}`,
          paneKey: `perf-pane-${index}`,
          dispatchCommand
        })
      })
    )
    try {
      act(() => {
        panes[0].result.current.surface?.demandModelCatalog?.()
      })
      await act(async () => {})
      expect(localRead).toHaveBeenCalledTimes(1)
      resolve.mockClear()
      const settled = [...renders]
      for (let index = 0; index < 10; index++) {
        act(() =>
          useAppStore.setState({
            agentStatusByPaneKey: {
              ...useAppStore.getState().agentStatusByPaneKey,
              unrelated: {
                paneKey: 'unrelated',
                stateHistory: [],
                state: 'working',
                prompt: '',
                updatedAt: index,
                stateStartedAt: 0,
                model: index % 2 ? 'low' : 'high'
              }
            }
          })
        )
      }
      expect(resolve).not.toHaveBeenCalled()
      expect(localRead).toHaveBeenCalledTimes(1)
      expect(renders).toEqual(settled)
      act(() =>
        useAppStore.setState({
          detectedWorktreesByRepo: {
            remote: makeDetectedResult('remote', [
              makeWorktree({
                id: 'remote::/remote/new',
                repoId: 'remote',
                hostId: 'runtime:other',
                runtimeOwnerEnvironmentId: 'other'
              })
            ])
          }
        })
      )
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(localRead).toHaveBeenCalledTimes(1)
      expect(renders).toEqual(settled)
      act(() =>
        useAppStore.setState({
          agentStatusByPaneKey: {
            ...useAppStore.getState().agentStatusByPaneKey,
            'perf-pane-0': {
              paneKey: 'perf-pane-0',
              stateHistory: [],
              state: 'working',
              prompt: '',
              updatedAt: 1,
              stateStartedAt: 0,
              model: 'gemini-3.8-flash-medium'
            }
          }
        })
      )
      expect(modelId(panes[0].result.current.snapshot)).toBe('gemini-3.8-flash-medium')
      expect(renders[0]).toBeGreaterThan(settled[0])
      expect(renders.slice(1)).toEqual(settled.slice(1))
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(localRead).toHaveBeenCalledTimes(1)
    } finally {
      panes.forEach(({ unmount }) => unmount())
      resolve.mockRestore()
    }
  }
)

function modelId(snapshot: { id: string; kind: unknown }[]): unknown {
  const model = snapshot.find(({ id }) => id === 'model')?.kind
  return model && typeof model === 'object' && 'currentValue' in model
    ? model.currentValue
    : undefined
}
