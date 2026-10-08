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

import {
  adoptAgentSessionLaunchVerdict,
  planAgentSessionLaunch,
  structuredAgentSessionLaunchFeasible
} from './agent-session-launch-plan'

const store = { settings: {} } as unknown as AgentLaunchRouteStore
const ROUTE_INPUT = { agent: 'codex', executionHostId: 'local' }
const STRUCTURED = { kind: 'structured', sessionId: 'session-1' }
const hooks = { onStructuredReady: vi.fn() }

describe('planAgentSessionLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildAgentLaunchRouteInput.mockReturnValue(ROUTE_INPUT)
    mocks.resolveAgentLaunchRoute.mockReturnValue('structured-native-chat')
    mocks.structuredAgentLaunchSupported.mockReturnValue(true)
    mocks.beginStructuredAgentLaunchSettlement.mockReturnValue({
      sessionId: 'session-1',
      settlement: Promise.resolve(STRUCTURED)
    })
  })

  it('decides the route once, from the builder input, and never again on launch', async () => {
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-1',
      agent: 'codex',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
      prompt: 'Fix it',
      promptDelivery: 'draft'
    })

    expect(plan.route).toBe('structured-native-chat')
    expect(mocks.buildAgentLaunchRouteInput).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ agent: 'codex', prompt: 'Fix it', promptDelivery: 'draft' })
    )
    expect(mocks.resolveAgentLaunchRoute).toHaveBeenCalledWith(ROUTE_INPUT)
    expect(mocks.structuredAgentLaunchSupported).not.toHaveBeenCalled()

    await plan.launch(hooks)
    await plan.launch(hooks)
    expect(mocks.buildAgentLaunchRouteInput).toHaveBeenCalledOnce()
    expect(mocks.resolveAgentLaunchRoute).toHaveBeenCalledOnce()
  })

  it('hands the settle loop exactly the request, prompt, mode, resume source, and delivery hook it planned on', async () => {
    const onPromptDelivered = vi.fn()
    const resumeFrom = { providerSessionId: 'provider-1' }
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-2',
      agent: 'claude',
      workspace: { kind: 'folder', worktreeId: 'folder:ws-1' },
      prompt: 'Review this',
      promptDelivery: 'submit-after-ready',
      resumeFrom,
      onPromptDelivered
    })

    await expect(plan.launch(hooks)).resolves.toBe(STRUCTURED)
    expect(mocks.beginStructuredAgentLaunchSettlement).toHaveBeenCalledWith(
      'folder:ws-1',
      'claude',
      {
        requestId: 'request-2',
        prompt: 'Review this',
        promptDelivery: 'submit-after-ready',
        resumeFrom,
        onPromptDelivered,
        // The chat is created on the host the route was decided for.
        executionHostId: 'local'
      },
      hooks
    )
  })

  it('sends no delivery fields the request did not carry', async () => {
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-3',
      agent: 'codex',
      workspace: { kind: 'folder', worktreeId: 'folder:ws-1' }
    })

    await plan.launch(hooks)
    expect(mocks.beginStructuredAgentLaunchSettlement).toHaveBeenCalledWith(
      'folder:ws-1',
      'codex',
      { requestId: 'request-3', executionHostId: 'local' },
      hooks
    )
  })

  // The route is the one gate: it admits only an agent the host registered as structured.
  it('launches any agent the structured route admitted', async () => {
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-4',
      agent: 'grok',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    })

    await expect(plan.launch(hooks)).resolves.toEqual(STRUCTURED)
    expect(mocks.beginStructuredAgentLaunchSettlement).toHaveBeenCalledWith(
      'wt-1',
      'grok',
      { requestId: 'request-4', executionHostId: 'local' },
      hooks
    )
  })

  it('opens nothing structured on a route that is not', async () => {
    mocks.resolveAgentLaunchRoute.mockReturnValue('legacy-native-chat')
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-4b',
      agent: 'grok',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    })

    await expect(plan.launch(hooks)).resolves.toBeNull()
    expect(plan.begin(hooks)).toBeNull()
    expect(mocks.beginStructuredAgentLaunchSettlement).not.toHaveBeenCalled()
  })

  it('launches into the workspace created after planning when the target names one', async () => {
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-5',
      agent: 'codex',
      workspace: { kind: 'git-worktree', repoId: 'repo-1' },
      prompt: 'Fix it',
      promptDelivery: 'auto-submit'
    })

    await plan.launch(hooks, { worktreeId: 'wt-created' })
    expect(mocks.beginStructuredAgentLaunchSettlement).toHaveBeenCalledWith(
      'wt-created',
      'codex',
      {
        requestId: 'request-5',
        prompt: 'Fix it',
        promptDelivery: 'auto-submit',
        executionHostId: 'local'
      },
      hooks
    )
  })

  it('refuses to launch a prospective workspace that was never created', async () => {
    const plan = planAgentSessionLaunch(store, {
      requestId: 'request-6',
      agent: 'codex',
      workspace: { kind: 'git-worktree', repoId: 'repo-1' }
    })

    await expect(plan.launch(hooks)).rejects.toThrow(/workspace/)
    expect(mocks.beginStructuredAgentLaunchSettlement).not.toHaveBeenCalled()
  })
})

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

  it("downgrades Claude to the terminal on the project's saved account or an explicit one", () => {
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

describe('structuredAgentSessionLaunchFeasible', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildAgentLaunchRouteInput.mockReturnValue(ROUTE_INPUT)
    mocks.structuredAgentLaunchSupported.mockReturnValue(true)
  })

  it.each([true, false])('answers from feasibility alone (supported=%s)', (supported) => {
    mocks.structuredAgentLaunchSupported.mockReturnValue(supported)
    const settings = { experimentalStructuredNativeChat: true } as never

    expect(
      structuredAgentSessionLaunchFeasible(store, {
        agent: 'codex',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
        settings
      })
    ).toBe(supported)
    expect(mocks.resolveAgentLaunchRoute).not.toHaveBeenCalled()
    expect(mocks.beginStructuredAgentLaunchSettlement).not.toHaveBeenCalled()
  })

  it('builds the input from the named settings, not the store copy', () => {
    const settings = { experimentalStructuredNativeChat: true } as never
    structuredAgentSessionLaunchFeasible(store, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
      settings
    })

    expect(mocks.buildAgentLaunchRouteInput).toHaveBeenCalledWith(store, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    })
    // The builder's input carries no settings, so seeing them here proves the named copy won.
    expect(mocks.structuredAgentLaunchSupported).toHaveBeenCalledWith(
      expect.objectContaining({ ...ROUTE_INPUT, settings })
    )
  })
})

describe('adoptAgentSessionLaunchVerdict', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.beginStructuredAgentLaunchSettlement.mockReturnValue({
      sessionId: 'session-1',
      settlement: Promise.resolve(STRUCTURED)
    })
  })

  it('re-enters a persisted verdict without resolving the route again', async () => {
    const plan = adoptAgentSessionLaunchVerdict({
      requestId: 'request-7',
      route: 'structured-native-chat',
      agent: 'codex',
      prompt: 'Fix it',
      promptDelivery: 'draft'
    })

    expect(plan.route).toBe('structured-native-chat')
    await expect(plan.launch(hooks, { worktreeId: 'wt-recovered' })).resolves.toBe(STRUCTURED)
    expect(mocks.buildAgentLaunchRouteInput).not.toHaveBeenCalled()
    expect(mocks.resolveAgentLaunchRoute).not.toHaveBeenCalled()
    expect(mocks.structuredAgentLaunchSupported).not.toHaveBeenCalled()
    expect(mocks.beginStructuredAgentLaunchSettlement).toHaveBeenCalledWith(
      'wt-recovered',
      'codex',
      { requestId: 'request-7', prompt: 'Fix it', promptDelivery: 'draft' },
      hooks
    )
  })

  it('keeps a non-structured verdict out of the loop', async () => {
    const plan = adoptAgentSessionLaunchVerdict({
      requestId: 'request-8',
      route: 'terminal-tui',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    await expect(plan.launch(hooks)).resolves.toBeNull()
    expect(mocks.beginStructuredAgentLaunchSettlement).not.toHaveBeenCalled()
  })
})
