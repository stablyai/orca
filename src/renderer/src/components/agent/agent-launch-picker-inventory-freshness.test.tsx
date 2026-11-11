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
