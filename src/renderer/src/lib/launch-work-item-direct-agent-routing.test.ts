import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  launchAgentSession: vi.fn(),
  preflightAgentTrust: vi.fn()
}))

vi.mock('@/lib/launch-agent-session', () => ({ launchAgentSession: mocks.launchAgentSession }))
vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: mocks.preflightAgentTrust
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

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

  it('preserves editable delivery through the shared launcher', async () => {
    mocks.launchAgentSession.mockResolvedValue({
      kind: 'structured',
      sessionId: 'draft-session',
      tabId: 'agent-session:draft-session'
    })
    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toMatchObject({
      completed: true,
      structuredLaunch: true,
      failed: false
    })
    expect(mocks.launchAgentSession).toHaveBeenCalledWith(expect.anything(), {
      agent: 'codex',
      workspaceId: 'worktree-1',
      prompt: 'Fix the route',
      promptDelivery: 'draft',
      visibility: 'reveal',
      launchSource: 'task_page',
      launchPlan: structuredPlan
    })
  })

  it('maps terminal refusal, unknown visibility, failure, and cancellation', async () => {
    mocks.launchAgentSession.mockResolvedValueOnce({
      kind: 'terminal',
      tabId: 'fallback-tab',
      viaRefusal: true
    })
    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toMatchObject({
      structuredLaunch: false,
      primaryTabId: 'fallback-tab'
    })
    mocks.launchAgentSession.mockResolvedValueOnce({ kind: 'visibility-unknown', sessionId: 's' })
    await expect(settleDirectWorkItemStructuredLaunch(baseArgs)).resolves.toMatchObject({
      visibilityUnknown: true
    })
    for (const outcome of [{ kind: 'failed', error: new Error('x') }, { kind: 'cancelled' }]) {
      mocks.launchAgentSession.mockResolvedValueOnce(outcome)
      await expect(
        settleDirectWorkItemStructuredLaunch({ ...baseArgs, primaryTabId: 'setup-shell' })
      ).resolves.toMatchObject({ failed: true, primaryTabId: null })
    }
  })

  it('skips non-structured plans', async () => {
    await expect(
      settleDirectWorkItemStructuredLaunch({
        ...baseArgs,
        plan: adoptAgentSessionLaunchVerdict({ ...structuredPlan, route: 'terminal-tui' })
      })
    ).resolves.toMatchObject({ structuredLaunch: false })
    expect(mocks.launchAgentSession).not.toHaveBeenCalled()
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

  it('leaves trust to the shared refusal fallback on structured routes', async () => {
    await markDirectWorkItemAgentTrusted({
      structuredLaunch: true,
      agent: 'codex',
      workspacePath: '/repo/worktree',
      connectionId: null
    })
    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
  })
})
