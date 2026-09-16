import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentLaunchSettlement } from './structured-agent-launch-settlement'

type BeginArgs = {
  plan: unknown
  targetGroupId?: string
  beforeOpen?: (sessionId: string) => boolean | void
}
type Launch = {
  sessionId: string
  tab: { id: string }
  settlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
}

const mocks = vi.hoisted(() => ({
  beginStructuredAgentSessionProvisionalLaunch: vi.fn<(args: BeginArgs) => Launch | null>()
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { launchAgentInStructuredNewTab } from './launch-agent-in-new-tab-structured'

type Delivery = 'auto-submit' | 'submit-after-ready' | 'draft'
const structuredPlan = (prompt: string, promptDelivery: Delivery) =>
  adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    agent: 'codex',
    worktreeId: 'wt-1',
    prompt,
    promptDelivery
  })

describe('launchAgentInStructuredNewTab', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation(() => ({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'structured', sessionId: 'session-1' })
    }))
  })

  afterEach(() => consoleError.mockRestore())

  it('returns the usable chat surface immediately and settles in the background', async () => {
    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'submit-after-ready'),
      targetGroupId: 'group-1'
    })

    expect(result).toMatchObject({ sessionId: 'session-1', tabId: 'agent-session:session-1' })
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ plan: expect.anything(), targetGroupId: 'group-1', hooks: {} })
    )
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'session-1'
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('reports failed settlement without opening a terminal fallback', async () => {
    const error = new Error('boom')
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'failed', error })
    })

    const result = launchAgentInStructuredNewTab({ plan: structuredPlan('Fix it', 'auto-submit') })

    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'failed', error })
    expect(consoleError).toHaveBeenCalledWith('Structured agent launch failed', error)
  })

  it('returns null when the route cannot begin', () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue(null)
    expect(
      launchAgentInStructuredNewTab({ plan: structuredPlan('Fix it', 'auto-submit') })
    ).toBeNull()
  })

  it('does not expose a delivery promise for drafts', () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue({
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve({ kind: 'structured', sessionId: 'session-1' }),
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    const result = launchAgentInStructuredNewTab({ plan: structuredPlan('Fix it', 'draft') })
    expect(result?.promptDeliveryResult).toBeUndefined()
  })
})
