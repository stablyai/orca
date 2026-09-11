import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchRouteStore } from './agent-launch-route-input'

const mocks = vi.hoisted(() => ({
  buildAgentLaunchRouteInput: vi.fn(),
  resolveProspectiveWorkspaceExecutionHostId: vi.fn(),
  resolveAgentLaunchRoute: vi.fn(),
  structuredAgentLaunchSupported: vi.fn(),
  settleStructuredAgentLaunch: vi.fn()
}))

vi.mock('@/lib/agent-launch-route-input', () => ({
  buildAgentLaunchRouteInput: mocks.buildAgentLaunchRouteInput,
  resolveProspectiveWorkspaceExecutionHostId: mocks.resolveProspectiveWorkspaceExecutionHostId
}))
vi.mock('@/lib/agent-launch-routing', () => ({
  resolveAgentLaunchRoute: mocks.resolveAgentLaunchRoute,
  structuredAgentLaunchSupported: mocks.structuredAgentLaunchSupported
}))
vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: mocks.settleStructuredAgentLaunch
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
    mocks.resolveProspectiveWorkspaceExecutionHostId.mockReturnValue('local')
    mocks.resolveAgentLaunchRoute.mockReturnValue('structured-native-chat')
    mocks.structuredAgentLaunchSupported.mockReturnValue(true)
    mocks.settleStructuredAgentLaunch.mockResolvedValue(STRUCTURED)
  })

  it('decides the route once, from the builder input, and never again on launch', async () => {
    const plan = planAgentSessionLaunch(store, {
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

  it('hands the settle loop exactly the prompt, mode, resume source, and delivery hook it planned on', async () => {
    const onPromptDelivered = vi.fn()
    const resumeFrom = { providerSessionId: 'provider-1' }
    const plan = planAgentSessionLaunch(store, {
      agent: 'claude',
      workspace: { kind: 'folder', worktreeId: 'folder:ws-1' },
      prompt: 'Review this',
      promptDelivery: 'submit-after-ready',
      resumeFrom,
      onPromptDelivered
    })

    await expect(plan.launch(hooks)).resolves.toBe(STRUCTURED)
    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'folder:ws-1',
      'claude',
      {
        prompt: 'Review this',
        promptDelivery: 'submit-after-ready',
        resumeFrom,
        onPromptDelivered
      },
      hooks
    )
  })

  it('sends no delivery fields the request did not carry', async () => {
    const plan = planAgentSessionLaunch(store, {
      agent: 'codex',
      workspace: { kind: 'folder', worktreeId: 'folder:ws-1' }
    })

    await plan.launch(hooks)
    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'folder:ws-1',
      'codex',
      {},
      hooks
    )
  })

  it.each(['legacy-native-chat', 'terminal-tui'] as const)(
    'returns null from launch on the %s route without touching the loop',
    async (route) => {
      mocks.resolveAgentLaunchRoute.mockReturnValue(route)
      const plan = planAgentSessionLaunch(store, {
        agent: 'codex',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
      })

      expect(plan.route).toBe(route)
      await expect(plan.launch(hooks)).resolves.toBeNull()
      expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
    }
  )

  it('returns null for an agent that cannot hold a structured session even on the structured route', async () => {
    const plan = planAgentSessionLaunch(store, {
      agent: 'gemini',
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' }
    })

    await expect(plan.launch(hooks)).resolves.toBeNull()
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
  })

  it('launches into the workspace created after planning when the target names one', async () => {
    const plan = planAgentSessionLaunch(store, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', repoId: 'repo-1' },
      prompt: 'Fix it',
      promptDelivery: 'auto-submit'
    })

    await plan.launch(hooks, { worktreeId: 'wt-created' })
    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'wt-created',
      'codex',
      { prompt: 'Fix it', promptDelivery: 'auto-submit' },
      hooks
    )
  })

  it('refuses to launch a prospective workspace that was never created', async () => {
    const plan = planAgentSessionLaunch(store, {
      agent: 'codex',
      workspace: { kind: 'git-worktree', repoId: 'repo-1' }
    })

    await expect(plan.launch(hooks)).rejects.toThrow(/workspace/)
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
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
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
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
    mocks.settleStructuredAgentLaunch.mockResolvedValue(STRUCTURED)
  })

  it('re-enters a persisted verdict without resolving the route again', async () => {
    const plan = adoptAgentSessionLaunchVerdict({
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
    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'wt-recovered',
      'codex',
      { prompt: 'Fix it', promptDelivery: 'draft' },
      hooks
    )
  })

  it('keeps a non-structured verdict out of the loop', async () => {
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'terminal-tui',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    await expect(plan.launch(hooks)).resolves.toBeNull()
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
  })
})
