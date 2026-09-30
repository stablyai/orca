import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionLaunchPlan } from './agent-session-launch-plan'

type BeginArgs = { beforeOpen: (sessionId: string) => boolean | void }

const mocks = vi.hoisted(() => ({
  beginStructuredAgentSessionProvisionalLaunch:
    vi.fn<(args: BeginArgs) => { sessionId: string; tab: { id: string } } | null>()
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { beginDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'

const structuredPlan: AgentSessionLaunchPlan = adoptAgentSessionLaunchVerdict({
  route: 'structured-native-chat',
  agent: 'codex',
  worktreeId: 'worktree-1',
  prompt: 'Fix the route',
  promptDelivery: 'draft'
})

describe('beginDirectWorkItemStructuredLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })
  })

  it('opens the provisional chat synchronously and preserves the requested tab id', () => {
    const order: string[] = []
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      order.push('begin')
      args.beforeOpen('session-1')
      order.push('open')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    expect(
      beginDirectWorkItemStructuredLaunch({
        plan: structuredPlan,
        primaryTabId: null,
        beforeOpen: (sessionId) => {
          order.push(`reveal:${sessionId}`)
          return true
        }
      })
    ).toEqual({ completed: true, structuredLaunch: true, primaryTabId: 'agent-session:session-1' })
    expect(order).toEqual(['begin', 'reveal:session-1', 'open'])
  })

  it('does not claim completion when the provisional opener is refused', () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue(null)

    expect(
      beginDirectWorkItemStructuredLaunch({
        plan: structuredPlan,
        primaryTabId: 'setup-shell-tab',
        beforeOpen: vi.fn()
      })
    ).toEqual({ completed: false, structuredLaunch: true, primaryTabId: 'setup-shell-tab' })
  })

  it('skips structured opening for non-structured routes', () => {
    expect(
      beginDirectWorkItemStructuredLaunch({
        plan: adoptAgentSessionLaunchVerdict({ ...structuredPlan, route: 'legacy-native-chat' }),
        primaryTabId: null,
        beforeOpen: vi.fn()
      })
    ).toEqual({ completed: false, structuredLaunch: false, primaryTabId: null })
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).not.toHaveBeenCalled()
  })
})
