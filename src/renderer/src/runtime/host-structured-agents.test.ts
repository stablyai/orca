import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { RuntimeCapability } from '../../../shared/protocol-version'

type Statuses = Map<string, RuntimeEnvironmentStatus>
type StoreState = {
  runtimeStatusByEnvironmentId: Statuses
  settings: { experimentalStructuredNativeChat: boolean } | null
}

const ON = { experimentalStructuredNativeChat: true }

const mocks = vi.hoisted(() => {
  const state: StoreState = { runtimeStatusByEnvironmentId: new Map(), settings: null }
  return {
    callRuntimeRpc: vi.fn(),
    ensureLocalRuntimeCapabilities: vi.fn(),
    capabilitiesKnown: new Set<(capabilities: readonly string[]) => void>(),
    state,
    listeners: new Set<(state: StoreState, previous: StoreState) => void>()
  }
})

vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('./local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilitiesKnown: (listener: (capabilities: readonly string[]) => void) => {
    mocks.capabilitiesKnown.add(listener)
    return () => mocks.capabilitiesKnown.delete(listener)
  }
}))
vi.mock('./local-structured-chats', () => ({
  localStructuredChatsInUse: async (settings: StoreState['settings']) =>
    settings?.experimentalStructuredNativeChat === true
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: (listener: (state: StoreState, previous: StoreState) => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))

import {
  readHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from './host-structured-agents'
import { installHostStructuredAgentsSync } from './host-structured-agents-sync'

const REGISTERED: RuntimeCapability[] = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]
const GROK_LIST = {
  agents: [
    { agent: 'claude', capabilities: { imagePrompts: true } },
    { agent: 'grok', capabilities: { contextUsage: true, steering: 'queue' } }
  ]
}

function pairedStatus(
  runtimeId: string,
  capabilities: RuntimeCapability[]
): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId,
      capabilities,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1
  }
}

function setStatuses(statuses: Statuses): void {
  const previous = mocks.state
  mocks.state = { ...previous, runtimeStatusByEnvironmentId: statuses }
  mocks.listeners.forEach((listener) => listener(mocks.state, previous))
}

const agentIds = (hostId: string): string[] | undefined =>
  readHostStructuredAgents(hostId, mocks.state.runtimeStatusByEnvironmentId)?.map(
    (row) => row.agent
  )

let uninstall: (() => void) | undefined

beforeEach(() => {
  resetHostStructuredAgentsForTests()
  mocks.state = { runtimeStatusByEnvironmentId: new Map(), settings: ON }
  mocks.listeners.clear()
  mocks.capabilitiesKnown.clear()
  mocks.callRuntimeRpc.mockReset().mockResolvedValue(GROK_LIST)
  mocks.ensureLocalRuntimeCapabilities.mockReset().mockResolvedValue(REGISTERED)
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
})

describe('host structured agents', () => {
  // The capability promises a renderer that reads the list; it ships only with that reader.
  it('is advertised to paired hosts, whose lists this reader serves', () => {
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    )
  })

  it("reads the local host's agents once it advertises them", async () => {
    uninstall = installHostStructuredAgentsSync()
    await vi.waitFor(() => expect(agentIds('local')).toEqual(['claude', 'grok']))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.agents',
      {},
      {}
    )
  })

  it('never asks a host that does not advertise registered agents', async () => {
    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue([
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    uninstall = installHostStructuredAgentsSync()
    setStatuses(
      new Map([['env-1', pairedStatus('rt-1', [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])]])
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(agentIds('local')).toBeUndefined()
    expect(agentIds('runtime:env-1')).toBeUndefined()
  })

  it("reads a paired host's agents per runtime, and a restarted host is unlearned until it answers", async () => {
    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(null)
    uninstall = installHostStructuredAgentsSync()
    setStatuses(new Map([['env-1', pairedStatus('rt-1', REGISTERED)]]))
    await vi.waitFor(() => expect(agentIds('runtime:env-1')).toEqual(['claude', 'grok']))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'agentSession.agents',
      {},
      { expectedEnvironmentRuntimeId: 'rt-1' }
    )

    let answer!: (value: unknown) => void
    mocks.callRuntimeRpc.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    setStatuses(new Map([['env-1', pairedStatus('rt-2', REGISTERED)]]))
    expect(agentIds('runtime:env-1')).toBeUndefined()

    answer({ agents: [{ agent: 'claude', capabilities: {} }] })
    await vi.waitFor(() => expect(agentIds('runtime:env-1')).toEqual(['claude']))
  })

  // Asking installs a host's structured store; a profile with structured chat off never pays it.
  it('asks no host until structured chat is turned on', async () => {
    mocks.state = { ...mocks.state, settings: { experimentalStructuredNativeChat: false } }
    uninstall = installHostStructuredAgentsSync()
    setStatuses(new Map([['env-1', pairedStatus('rt-1', REGISTERED)]]))
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    const previous = mocks.state
    mocks.state = { ...previous, settings: ON }
    mocks.listeners.forEach((listener) => listener(mocks.state, previous))
    await vi.waitFor(() => expect(agentIds('local')).toEqual(['claude', 'grok']))
    await vi.waitFor(() => expect(agentIds('runtime:env-1')).toEqual(['claude', 'grok']))
  })

  it("reads the local host's agents once its capabilities land, when startup asked too early", async () => {
    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(null)
    uninstall = installHostStructuredAgentsSync()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

    mocks.ensureLocalRuntimeCapabilities.mockResolvedValue(REGISTERED)
    mocks.capabilitiesKnown.forEach((listener) => listener(REGISTERED))

    await vi.waitFor(() => expect(agentIds('local')).toEqual(['claude', 'grok']))
  })

  it('leaves a host unlearned when its reply is not an agent list', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ unexpected: true })
    uninstall = installHostStructuredAgentsSync()
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalled())
    await Promise.resolve()

    expect(agentIds('local')).toBeUndefined()
  })
})
