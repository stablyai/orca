import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { TuiAgent } from '../../../shared/tui-agent'

const mocks = vi.hoisted(() => ({
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn(),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({ getExecutionHostIdForWorktree: vi.fn() }))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn()
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/structured-agent-launch-settlement', () => ({}))

import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import type { AgentLaunchRouteStore, ProspectiveWorkspace } from './agent-launch-route-input'
import { planAgentSessionLaunch } from './agent-session-launch-plan'

const STRUCTURED: RuntimeCapability[] = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
const REGISTERED: RuntimeCapability[] = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]
const LISTS_GROK = {
  agents: [
    { agent: 'claude', capabilities: {} },
    { agent: 'codex', capabilities: {} },
    { agent: 'grok', capabilities: {} }
  ]
}
const SETTINGS = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
}
const LOCAL: ProspectiveWorkspace = { kind: 'git-worktree', repoId: 'repo-1' }
const PAIRED: ProspectiveWorkspace = { kind: 'git-worktree', runtimeEnvironmentId: 'env-1' }

function pairedStatus(runtimeId: string): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId,
      capabilities: REGISTERED,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1
  }
}

type RouteSettings = Partial<typeof SETTINGS> &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv'>>

function store(
  overrides: { settings?: RouteSettings; runtimeId?: string } = {}
): AgentLaunchRouteStore {
  const state = {
    settings: { ...SETTINGS, ...overrides.settings },
    runtimeStatusByEnvironmentId: new Map([['env-1', pairedStatus(overrides.runtimeId ?? 'rt-1')]]),
    worktreesByRepo: {},
    folderWorkspaces: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route builder reads only the settings, host statuses and workspace rows given here; a missing member reads as absent, as the sibling route tests rely on.
  return state as unknown as AgentLaunchRouteStore
}

const routeFor = (appStore: AgentLaunchRouteStore, agent: TuiAgent, workspace = LOCAL) =>
  planAgentSessionLaunch(appStore, { requestId: 'request-1', agent, workspace }).route

beforeEach(() => {
  resetHostStructuredAgentsForTests()
  mocks.callRuntimeRpc.mockReset().mockResolvedValue(LISTS_GROK)
  mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReset().mockReturnValue(REGISTERED)
})

describe('structured launch of a host-registered agent', () => {
  it('opens a chat for an agent the local host listed', async () => {
    await loadHostStructuredAgents('local', REGISTERED, null)

    expect(routeFor(store(), 'grok')).toBe('structured-native-chat')
  })

  it('never offers it from a host without the registered-agents capability', async () => {
    await loadHostStructuredAgents('local', REGISTERED, null)
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue(STRUCTURED)

    expect(routeFor(store(), 'grok')).not.toBe('structured-native-chat')
    // The agents every build ships stay offered there.
    expect(routeFor(store(), 'claude')).toBe('structured-native-chat')
  })

  it('does not offer it before the host has listed it', () => {
    expect(routeFor(store(), 'grok')).not.toBe('structured-native-chat')
    expect(routeFor(store(), 'codex')).toBe('structured-native-chat')
  })

  it('does not offer an agent the host did not list', async () => {
    await loadHostStructuredAgents('local', REGISTERED, null)

    expect(routeFor(store(), 'gemini')).not.toBe('structured-native-chat')
  })

  it('keeps the experimental chat setting authoritative', async () => {
    await loadHostStructuredAgents('local', REGISTERED, null)

    expect(
      routeFor(store({ settings: { experimentalStructuredNativeChat: false } }), 'grok')
    ).not.toBe('structured-native-chat')
  })

  it("reads a paired host's list only from the runtime that gave it", async () => {
    await loadHostStructuredAgents('runtime:env-1', REGISTERED, 'rt-1')

    expect(routeFor(store(), 'grok', PAIRED)).toBe('structured-native-chat')
    expect(routeFor(store({ runtimeId: 'rt-2' }), 'grok', PAIRED)).not.toBe(
      'structured-native-chat'
    )
  })
})

describe('OpenCode with its Command and environment set (live QA run 5)', () => {
  const LISTS_OPENCODE = {
    agents: [...LISTS_GROK.agents, { agent: 'opencode', capabilities: {} }]
  }
  // The rig's settings: a private binary named twice, which must not decide the surface.
  const withOverrides = (): AgentLaunchRouteStore =>
    store({
      settings: {
        agentCmdOverrides: { opencode: '/rig/oc-prefix/bin/opencode' },
        agentDefaultEnv: { opencode: { PATH: '/rig/oc-prefix/bin:/usr/bin:/bin' } }
      }
    })
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('opens a chat once the local host listed OpenCode', async () => {
    mocks.callRuntimeRpc.mockResolvedValue(LISTS_OPENCODE)
    await loadHostStructuredAgents('local', REGISTERED, null)

    expect(routeFor(withOverrides(), 'opencode')).toBe('structured-native-chat')
  })

  it('says why it opened the terminal chat and asks the host again after a failed startup read', async () => {
    mocks.callRuntimeRpc.mockRejectedValueOnce(new Error('host not ready'))
    await loadHostStructuredAgents('local', REGISTERED, null)
    mocks.callRuntimeRpc.mockResolvedValue(LISTS_OPENCODE)

    // What run 5 saw: the terminal-backed "OpenCode" chat, and no version check on the host.
    expect(routeFor(withOverrides(), 'opencode')).toBe('legacy-native-chat')
    expect(warn).toHaveBeenCalledWith(
      '[agent-launch-route] opencode opens legacy-native-chat: agent-without-structured-session ' +
        '(host local, host agents not learned, host capabilities known)'
    )
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2))
    // The next launch reads the list the re-ask learned.
    await vi.waitFor(() =>
      expect(routeFor(withOverrides(), 'opencode')).toBe('structured-native-chat')
    )
  })

  it('names the settings default when new agent tabs do not open as chats', () => {
    expect(routeFor(store({ settings: { openAgentTabsInChatByDefault: false } }), 'opencode')).toBe(
      'terminal-tui'
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('opencode opens terminal-tui: new-tabs-default-to-terminal')
    )
  })
})
