import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import type { RuntimeCapability } from '../../../../../../shared/protocol-version'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

const mocks = vi.hoisted(() => ({
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn(),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: vi.fn()
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn()
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/lib/agent-session/launch/continuation/structured-agent-launch-settlement', () => ({}))

import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
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
  nativeChatProviders: EVERY_AGENT_CHAT
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
    localDetectedAgentIdsByContext: { host: [] },
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
  it('never offers it from a host without the registered-agents capability', async () => {
    await loadHostStructuredAgents('local', REGISTERED, null)
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue(STRUCTURED)

    expect(routeFor(store(), 'grok')).not.toBe('structured-native-chat')
    expect(routeFor(store(), 'claude')).toBe('structured-native-chat')
  })

  it("reads a paired host's list only from the runtime that gave it", async () => {
    await loadHostStructuredAgents('runtime:env-1', REGISTERED, 'rt-1')

    expect(routeFor(store(), 'grok', PAIRED)).toBe('structured-native-chat')
    expect(routeFor(store({ runtimeId: 'rt-2' }), 'grok', PAIRED)).not.toBe(
      'structured-native-chat'
    )
  })
})
