import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRouteStore } from './agent-launch-route-input'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'

const mocks = vi.hoisted(() => ({
  buildAgentLaunchRouteInput: vi.fn(),
  resolveAgentLaunchRoute: vi.fn(),
  structuredAgentLaunchSupported: vi.fn(),
  beginStructuredAgentLaunchSettlement: vi.fn()
}))

vi.mock('@/lib/agent-launch-route-input', () => ({
  buildAgentLaunchRouteInput: mocks.buildAgentLaunchRouteInput
}))
vi.mock('@/lib/agent-launch-routing', () => ({
  resolveAgentLaunchRoute: mocks.resolveAgentLaunchRoute,
  structuredAgentLaunchSupported: mocks.structuredAgentLaunchSupported,
  structuredAgentLaunchDowngrade: () => null
}))
vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  beginStructuredAgentLaunchSettlement: mocks.beginStructuredAgentLaunchSettlement
}))

import { planAgentSessionLaunch } from './agent-session-launch-plan'

const store = { settings: {} } as unknown as AgentLaunchRouteStore
const ROUTE_INPUT = { agent: 'codex', executionHostId: 'local' }

describe('planAgentSessionLaunch with a pinned Claude account', () => {
  const pinnedStoreFixture = {
    settings: {},
    repos: [{ id: 'repo-1', agentAccounts: { claude: { mode: 'account', accountId: 'acct-1' } } }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only settings and repos off the store, and routing inputs are mocked.
  const pinnedStore = pinnedStoreFixture as unknown as AgentLaunchRouteStore
  const workspace = { kind: 'git-worktree' as const, worktreeId: 'repo-1::/repo/wt' }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildAgentLaunchRouteInput.mockReturnValue(ROUTE_INPUT)
    mocks.resolveAgentLaunchRoute.mockReturnValue('structured-native-chat')
  })

  it("downgrades Claude to the terminal on the project's saved account or an explicit one, even when chat was asked for", () => {
    expect(
      planAgentSessionLaunch(pinnedStore, { requestId: 'req-1', agent: 'claude', workspace }).route
    ).toBe('terminal-tui')
    expect(
      planAgentSessionLaunch(store, {
        requestId: 'req-1',
        agent: 'claude',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
        claudeAccountId: 'acct-2'
      }).route
    ).toBe('terminal-tui')
    expect(
      planAgentSessionLaunch(pinnedStore, {
        requestId: 'req-1',
        agent: 'claude',
        workspace,
        requestedSurface: 'chat'
      }).route
    ).toBe('terminal-tui')
  })

  it('keeps the structured route for the active-account choice and for other agents', () => {
    expect(
      planAgentSessionLaunch(pinnedStore, {
        requestId: 'req-1',
        agent: 'claude',
        workspace,
        claudeAccountId: ACTIVE_CLAUDE_ACCOUNT
      }).route
    ).toBe('structured-native-chat')
    expect(
      planAgentSessionLaunch(pinnedStore, { requestId: 'req-1', agent: 'codex', workspace }).route
    ).toBe('structured-native-chat')
  })
})
