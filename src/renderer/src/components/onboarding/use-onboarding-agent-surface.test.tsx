// @vitest-environment happy-dom

import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useChatAgentDetection, useOnboardingAgentSurface } from './use-onboarding-agent-surface'
import { usePersistCurrentStep } from './use-onboarding-flow-persistence'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import type * as HostStructuredAgents from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as HEALTH,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT
} from '../../../../shared/protocol-version'

const rpc = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: rpc.subscribe }))
vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof HostStructuredAgents>()),
  relearnHostStructuredAgents: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

let root: Root
let container: HTMLDivElement
const initialState = useAppStore.getState()
const initialApi = window.api

function Probe() {
  const settings = useAppStore((state) => state.settings)
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>('aider')
  const agentInteractedRef = useRef(false)
  const [step, setStep] = useState<'agent' | 'theme'>('agent')
  const updateSettings = useAppStore((state) => state.updateSettings)
  const flow = useOnboardingAgentSurface({
    settings,
    selectedAgent,
    setSelectedAgent,
    agentInteractedRef
  })
  const persist = usePersistCurrentStep({
    currentStepId: step,
    agentSurface: flow.agentSurface,
    selectedAgent,
    agentInteractedRef,
    yoloPermissions: false,
    yoloPermissionsChosen: { current: false },
    theme: 'dark',
    settings,
    updateSettings,
    onboardingChecklist: getDefaultOnboardingState().checklist,
    onOnboardingChange: () => {},
    setError: () => {}
  })
  return (
    <>
      <button onClick={() => flow.setAgentSurface('chat')}>Chat</button>
      <button
        onClick={() => {
          agentInteractedRef.current = true
          setSelectedAgent('aider')
        }}
      >
        Pick Aider
      </button>
      <button
        data-save
        onClick={async () => {
          if ((await persist()).ok) {
            setStep('theme')
          }
        }}
      >
        Continue
      </button>
      <output data-step={step}>{selectedAgent}</output>
    </>
  )
}

function choose(label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent === label
  )
  if (!button) {
    throw new Error(`Missing ${label} button`)
  }
  act(() => button.click())
}

beforeEach(() => {
  resetRendererAppPlatformCacheForTests()
  rpc.call.mockReset().mockResolvedValue({ agents: [] })
  rpc.subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn() })
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'aider' },
    updateSettings: async (updates) => {
      const settings = useAppStore.getState().settings
      if (!settings) {
        throw new Error('Missing settings')
      }
      useAppStore.setState({ settings: { ...settings, ...updates } })
    },
    refreshNativeDetectedAgents: vi.fn().mockResolvedValue([]),
    localDetectedAgentIdsByContext: {}
  })
  Reflect.set(window, 'api', {
    onboarding: {
      update: async (updates: Partial<OnboardingState>) => ({
        ...getDefaultOnboardingState(),
        ...updates
      })
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  resetRendererAppPlatformCacheForTests()
  act(() => root.unmount())
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  container.remove()
  useAppStore.setState(initialState, true)
  Reflect.set(window, 'api', initialApi)
})

it.each([true, false])(
  'selects Chat regardless of whether detection finishes first (%s)',
  (first) => {
    act(() => root.render(<Probe />))
    const detect = () =>
      act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
    if (first) {
      detect()
    }
    choose('Chat')
    if (!first) {
      detect()
    }
    expect(container.querySelector('output')?.textContent).toBe('codex')
  }
)

it('preserves an explicit terminal-only pick when detection settles', () => {
  act(() => root.render(<Probe />))
  choose('Chat')
  choose('Pick Aider')
  act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
  expect(container.querySelector('output')?.textContent).toBe('aider')
})

it('keeps provider opt-outs when choosing an installed Chat default', () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatProviders: { claude: false } },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  act(() => root.render(<Probe />))
  choose('Chat')
  expect(container.querySelector('output')?.textContent).toBe('codex')
  expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({ claude: false })
})

it('keeps the confirmed default when native detection finishes after the agent page', async () => {
  act(() => root.render(<Probe />))
  choose('Chat')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-save]')?.click())
  expect(container.querySelector('output')?.dataset.step).toBe('theme')
  expect(useAppStore.getState().settings?.defaultTuiAgent).toBe('aider')

  act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
  expect(container.querySelector('output')?.textContent).toBe('aider')
  expect(useAppStore.getState().settings?.defaultTuiAgent).toBe('aider')
})

function DetectionProbe() {
  const { chatDetected, refreshDetectedAgents } = useChatAgentDetection()
  useEffect(() => {
    void refreshDetectedAgents(undefined, { wakeWslDistro: true })
  }, [refreshDetectedAgents])
  return <output>{chatDetected?.join(',') ?? 'pending'}</output>
}

it.each(['darwin', 'linux', 'win32'] as const)(
  'refreshes a cold native %s inventory once and publishes it to Chat',
  async (platform) => {
    initialState.clearLocalDetectedAgents()
    const detectAgents = vi.fn().mockResolvedValue(['claude'])
    const refreshAgents = vi.fn().mockResolvedValue({
      agents: ['codex'],
      pathSource: 'process_env',
      pathFailureReason: 'none'
    })
    Reflect.set(window, 'api', {
      platform: { get: () => ({ platform }) },
      preflight: { detectAgents, refreshAgents }
    })
    useAppStore.setState({
      refreshNativeDetectedAgents: initialState.refreshNativeDetectedAgents,
      refreshDetectedAgents: initialState.refreshDetectedAgents,
      settings: {
        ...getDefaultSettings('/tmp'),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      },
      activeRepoId: null,
      activeWorktreeId: null,
      repos: [],
      projects: []
    })

    await act(async () => root.render(<DetectionProbe />))

    expect(refreshAgents).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ enabledOnly: true, wakeWslDistro: true })
    )
    expect(detectAgents).not.toHaveBeenCalled()
    expect(container.querySelector('output')?.textContent).toBe('codex')
  }
)

it('re-reads a cached native inventory when refreshing WSL', async () => {
  initialState.clearLocalDetectedAgents()
  const detectAgents = vi.fn().mockResolvedValue(['codex'])
  const refreshAgents = vi.fn(async (args: { wslDistro?: string }) => ({
    agents: args.wslDistro ? ['codex'] : ['claude'],
    pathSource: 'process_env',
    pathFailureReason: 'none'
  }))
  Reflect.set(window, 'api', {
    platform: { get: () => ({ platform: 'win32' }) },
    preflight: { detectAgents, refreshAgents }
  })
  useAppStore.setState({
    refreshNativeDetectedAgents: initialState.refreshNativeDetectedAgents,
    refreshDetectedAgents: initialState.refreshDetectedAgents,
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    },
    activeRepoId: null,
    activeWorktreeId: null,
    repos: [],
    projects: []
  })
  // Codex was uninstalled natively since the last read.
  await act(async () => {
    await initialState.ensureNativeDetectedAgents()
  })

  await act(async () => root.render(<DetectionProbe />))

  expect(refreshAgents).toHaveBeenCalledTimes(2)
  expect(refreshAgents).toHaveBeenCalledWith(
    expect.objectContaining({ wslDistro: 'Ubuntu', wakeWslDistro: true })
  )
  expect(refreshAgents).toHaveBeenCalledWith({ enabledOnly: true })
  expect(container.querySelector('output')?.textContent).toBe('claude')
  expect(useAppStore.getState().detectedAgentIds).toEqual(['codex'])
})

it('counts a downloaded Chat runtime without the CLI on PATH', async () => {
  setLocalRuntimeCapabilitiesForTests([CHAT, CATALOG, HEALTH])
  rpc.call.mockResolvedValue({
    agents: [{ agent: 'antigravity', capabilities: {}, managedRuntime: true }]
  })
  useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['aider'] } })
  await act(async () => root.render(<Probe />))
  expect(rpc.subscribe.mock.calls.at(-1)?.[0]).toEqual({ kind: 'local' })

  act(() =>
    rpc.subscribe.mock.calls.at(-1)?.[3].onEvent({
      type: 'availability',
      agents: [{ agent: 'antigravity', state: 'available', chatProgram: 'available' }]
    })
  )
  choose('Chat')

  expect(container.querySelector('output')?.textContent).toBe('antigravity')
})

it.each(['claude', 'codex'] as const)(
  'selects a ready custom %s Chat command without the CLI on PATH',
  async (agent) => {
    setLocalRuntimeCapabilitiesForTests([CHAT, CATALOG, HEALTH])
    rpc.call.mockResolvedValue({ agents: [{ agent, capabilities: {} }] })
    useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['aider'] } })
    await act(async () => root.render(<Probe />))
    act(() =>
      rpc.subscribe.mock.calls.at(-1)?.[3].onEvent({
        type: 'availability',
        agents: [{ agent, state: 'available', chatProgram: 'missing' }]
      })
    )
    choose('Chat')
    expect(container.querySelector('output')?.textContent).toBe('aider')

    act(() =>
      rpc.subscribe.mock.calls.at(-1)?.[3].onEvent({
        type: 'availability',
        agents: [{ agent, state: 'available', chatProgram: 'available' }]
      })
    )

    expect(container.querySelector('output')?.textContent).toBe(agent)
  }
)

it('does not count a managed Chat runtime that is only installable', async () => {
  setLocalRuntimeCapabilitiesForTests([CHAT, CATALOG, HEALTH])
  rpc.call.mockResolvedValue({
    agents: [{ agent: 'antigravity', capabilities: {}, managedRuntime: true }]
  })
  useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['aider'] } })
  await act(async () => root.render(<Probe />))

  act(() =>
    rpc.subscribe.mock.calls.at(-1)?.[3].onEvent({
      type: 'availability',
      agents: [{ agent: 'antigravity', state: 'available', chatProgram: 'installable' }]
    })
  )
  choose('Chat')

  expect(container.querySelector('output')?.textContent).toBe('aider')
})
