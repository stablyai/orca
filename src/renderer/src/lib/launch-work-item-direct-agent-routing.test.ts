import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settleStructuredAgentLaunch: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  preflightAgentTrust: vi.fn()
}))

vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: mocks.settleStructuredAgentLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: mocks.preflightAgentTrust
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: vi.fn(() => true)
}))

import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import {
  markDirectWorkItemAgentTrusted,
  settleDirectWorkItemStructuredLaunch
} from './launch-work-item-direct-agent-routing'

const structuredPlan = adoptAgentSessionLaunchVerdict({
  route: 'structured-native-chat',
  agent: 'codex',
  worktreeId: 'worktree-1',
  prompt: 'Fix the route',
  promptDelivery: 'draft'
})

const baseArgs = {
  plan: structuredPlan,
  worktreeId: 'worktree-1',
  workspacePath: '/repo/worktree',
  connectionId: null,
  primaryTabId: null,
  startupPlan: null,
  launchSource: 'task_page' as const
}

describe('settleDirectWorkItemStructuredLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves the editable delivery mode for the default-agent PR launch', async () => {
    mocks.settleStructuredAgentLaunch.mockResolvedValue({
      kind: 'structured',
      sessionId: 'draft-session'
    })
    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: true,
      structuredLaunch: true,
      visibilityUnknown: false,
      failed: false,
      primaryTabId: null
    })
    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'worktree-1',
      'codex',
      { prompt: 'Fix the route', promptDelivery: 'draft' },
      expect.anything()
    )
  })

  it('runs trust preflight and the legacy terminal as the refusal fallback', async () => {
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'fallback-tab' })
    mocks.settleStructuredAgentLaunch.mockImplementation(
      async (_worktreeId, _agent, _options, hooks) => ({
        kind: 'refused-then-legacy',
        ...(await hooks.legacyFallback())
      })
    )

    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: false,
      structuredLaunch: false,
      visibilityUnknown: false,
      failed: false,
      primaryTabId: 'fallback-tab'
    })
    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith({
      agent: 'codex',
      workspacePath: '/repo/worktree',
      connectionId: null
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'worktree-1',
      expect.objectContaining({ sidebarRevealBehavior: 'auto', createNewTerminalForStartup: true })
    )
  })

  it('reports an unknown outcome without starting a fallback terminal', async () => {
    mocks.settleStructuredAgentLaunch.mockResolvedValue({
      kind: 'visibility-unknown',
      sessionId: 'session-1'
    })

    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toEqual({
      completed: false,
      structuredLaunch: true,
      visibilityUnknown: true,
      failed: false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', { kind: 'failed', error: new Error('x') }],
    ['cancelled', { kind: 'cancelled', sessionId: 'session-1' }]
  ])(
    'drops the pre-launch tab on a %s settlement so nothing is pasted into it',
    async (_kind, settlement) => {
      mocks.settleStructuredAgentLaunch.mockResolvedValue(settlement)

      await expect(
        settleDirectWorkItemStructuredLaunch({ ...baseArgs, primaryTabId: 'setup-shell-tab' })
      ).resolves.toEqual({
        completed: false,
        structuredLaunch: true,
        visibilityUnknown: false,
        failed: true,
        primaryTabId: null
      })
      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    }
  )

  it('skips the loop when the route is not structured', async () => {
    await expect(
      settleDirectWorkItemStructuredLaunch({
        ...baseArgs,
        plan: adoptAgentSessionLaunchVerdict({ ...structuredPlan, route: 'legacy-native-chat' })
      })
    ).resolves.toEqual({
      completed: false,
      structuredLaunch: false,
      visibilityUnknown: false,
      failed: false,
      primaryTabId: null
    })
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
  })
})

describe('markDirectWorkItemAgentTrusted', () => {
  beforeEach(() => vi.clearAllMocks())

  it('marks trust before a legacy terminal launch', async () => {
    await markDirectWorkItemAgentTrusted({
      structuredLaunch: false,
      agent: 'codex',
      workspacePath: '/repo/worktree',
      connectionId: 'ssh-1'
    })

    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith({
      agent: 'codex',
      workspacePath: '/repo/worktree',
      connectionId: 'ssh-1'
    })
  })

  it('leaves trust to the refusal fallback on the structured route', async () => {
    await markDirectWorkItemAgentTrusted({
      structuredLaunch: true,
      agent: 'codex',
      workspacePath: '/repo/worktree',
      connectionId: null
    })

    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
  })
})
