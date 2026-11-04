import { beforeEach, describe, expect, it, vi } from 'vitest'

import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

import {
  createStructuredAgentSessionLaunchIntent,
  launchStructuredAgentSession,
  StructuredAgentSessionCreateRefusalError
} from './launch-structured-agent-session'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))
const hostPermission = vi.hoisted(() =>
  vi.fn<() => Promise<{ kind: string; hostMode?: null }>>(async () => ({ kind: 'allowed' }))
)
vi.mock('@/runtime/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: hostPermission
}))

describe('structured agent session launch', () => {
  beforeEach(() => {
    vi.mocked(callStructuredAgentSession).mockReset()
  })

  /** selector_not_found immediately after creation means not ready, not refusal; the new workspace may still be hydrating. */
  it('retries a probe the host cannot answer yet, then creates', async () => {
    const notResolvableYet = Object.assign(new Error('selector_not_found'), {
      code: 'selector_not_found'
    })
    vi.mocked(callStructuredAgentSession)
      .mockRejectedValueOnce(notResolvableYet)
      .mockRejectedValueOnce(notResolvableYet)
      .mockImplementation(async (_target, method) =>
        method === 'agentSession.createSupport'
          ? { supported: true }
          : { ok: true, replayed: false, value: { sessionId: 'claude_1', fence: 1 } }
      )

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
    await expect(launchStructuredAgentSession(intent)).resolves.toMatchObject({
      sessionId: 'claude_1'
    })
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.create'
    ])
  })

  it('refuses once the retry budget for an unresolvable selector is spent', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValue(
      Object.assign(new Error('selector_not_found'), { code: 'selector_not_found' })
    )

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')

    await expect(launchStructuredAgentSession(intent)).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    // Bounded: the first ask plus the retry delays, and never agentSession.create.
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport',
      'agentSession.createSupport'
    ])
  })

  /** The probe now runs for Codex too, so create-outcome tests script it to say yes. */
  function mockSupportedCreate(create: () => unknown): void {
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
      method === 'agentSession.createSupport' ? { supported: true } : create()
    )
  }

  it('replays the exact create envelope when an unknown outcome is retried', async () => {
    const intent = createStructuredAgentSessionLaunchIntent('workspace-retry', 'codex')
    mockSupportedCreate(() => {
      throw new Error('response lost')
    })

    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('response lost')
    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('response lost')

    const createCalls = vi
      .mocked(callStructuredAgentSession)
      .mock.calls.filter(([, method]) => method === 'agentSession.create')
    const first = createCalls[0]?.[2]
    const second = createCalls[1]?.[2]
    expect(first).toBe(intent.params)
    expect(second).toBe(first)
    expect(intent.params.envelope.clientOperationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
  })
})
