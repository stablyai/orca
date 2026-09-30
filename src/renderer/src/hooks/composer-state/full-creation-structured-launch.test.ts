import { beforeEach, describe, expect, it, vi } from 'vitest'

type BeginArgs = {
  plan: unknown
  target: { worktreeId: string }
  beforeOpen?: (sessionId: string) => boolean | void
}

const mocks = vi.hoisted(() => ({
  beginStructuredAgentSessionProvisionalLaunch:
    vi.fn<(args: BeginArgs) => { sessionId: string; tab: { id: string } } | null>()
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginFullCreationStructuredLaunch } from './full-creation-structured-launch'

const plan = adoptAgentSessionLaunchVerdict({
  route: 'structured-native-chat',
  agent: 'codex',
  prompt: 'Fix the route',
  promptDelivery: 'auto-submit'
})

describe('beginFullCreationStructuredLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })
  })

  it('allocates the final identity before revealing and opening the chat surface', () => {
    const order: string[] = []
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      order.push('begin')
      args.beforeOpen?.('session-1')
      order.push('open')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    const launch = beginFullCreationStructuredLaunch({
      plan,
      worktreeId: 'worktree-1',
      beforeOpen: (sessionId) => {
        order.push(`reveal:${sessionId}`)
        return true
      }
    })

    expect(launch).toMatchObject({ sessionId: 'session-1', tab: { id: 'agent-session:session-1' } })
    expect(order).toEqual(['begin', 'reveal:session-1', 'open'])
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith({
      plan,
      hooks: {},
      target: { worktreeId: 'worktree-1' },
      beforeOpen: expect.any(Function)
    })
  })

  it('returns no surface when reveal or ownership is refused', () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue(null)

    expect(
      beginFullCreationStructuredLaunch({ plan, worktreeId: 'worktree-1', beforeOpen: vi.fn() })
    ).toBeNull()
  })
})
