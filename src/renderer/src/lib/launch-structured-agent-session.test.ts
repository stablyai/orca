import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  createStructuredAgentSessionLaunchIntent,
  isDefinitiveStructuredAgentSessionCreateError,
  launchStructuredAgentSession,
  StructuredAgentSessionCreateRefusalError
} from './launch-structured-agent-session'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

describe('structured agent session launch', () => {
  beforeEach(() => {
    vi.mocked(callStructuredAgentSession).mockReset()
  })

  it('creates a native session with a host-verifiable launch intent', async () => {
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, _method, params) => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-1', sequence: 0 },
      value: {
        sessionId: (params as { envelope: { sessionId: string } }).envelope.sessionId,
        fence: 1,
        page: {
          sessionId: 'session-1',
          epoch: 'epoch-1',
          direction: 'tail',
          items: [],
          removedItemIds: [],
          submissions: [],
          window: {
            oldest: null,
            newest: null,
            nextCursor: { epoch: 'epoch-1', sequence: 0 }
          },
          liveCursor: { epoch: 'epoch-1', sequence: 0 },
          hasOlder: false,
          hasNewer: false
        },
        unconfirmedClientMessageIds: []
      }
    }))

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'codex')
    const receipt = await launchStructuredAgentSession(intent)
    const params = vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2] as {
      envelope: { sessionId: string; payloadFingerprint: string }
      worktree: string
      agent: 'codex'
    }

    expect(receipt).toEqual({
      sessionId: expect.stringMatching(/^codex_[A-Za-z0-9_]{36}$/),
      fence: 1
    })
    expect(callStructuredAgentSession).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.create',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' })
    )
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: params.envelope.sessionId,
        fields: { worktree: 'id:workspace-1', agent: 'codex' }
      })
    )
    expect(params).toBe(intent.params)
  })

  it('names Claude as the create provider and in the session id', () => {
    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
    expect(intent.sessionId).toMatch(/^claude_[A-Za-z0-9_]{36}$/)
    expect(intent.params.agent).toBe('claude')
    expect(intent.params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: intent.sessionId,
        fields: { worktree: 'id:workspace-1', agent: 'claude' }
      })
    )
  })

  it('asks the executing host for create support before creating a Claude session', async () => {
    vi.mocked(callStructuredAgentSession).mockImplementation(async (_target, method) =>
      method === 'agentSession.createSupport'
        ? { supported: true }
        : { ok: true, replayed: false, value: { sessionId: 'claude_1', fence: 1 } }
    )

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
    await launchStructuredAgentSession(intent)

    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.create'
    ])
    expect(callStructuredAgentSession).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'agentSession.createSupport',
      { worktree: 'id:workspace-1', agent: 'claude' }
    )
  })

  it('refuses a Claude launch the host says it cannot support, without creating', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({ supported: false, reason: 'agent' })

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')

    await expect(launchStructuredAgentSession(intent)).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.createSupport'
    ])
  })

  it('fails closed when the create support probe cannot be answered', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('runtime unreachable'))

    const intent = createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')

    await expect(launchStructuredAgentSession(intent)).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()
  })

  /** A worktree is not resolvable for a beat after createWorktree resolves, so the probe fails with
   *  selector_not_found instead of answering. That is "not ready", not "no". */
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

  it('does not retry a host that answered no, or an unrelated failure', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({ supported: false, reason: 'wsl' })
    await expect(
      launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
      )
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()

    vi.mocked(callStructuredAgentSession).mockReset()
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('runtime unreachable'))
    await expect(
      launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
      )
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()
  })

  /** A message-wrapped token must not be confused with prose that merely mentions it. */
  it('does not retry a failure that only mentions the token in passing', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValue(
      new Error('Access denied after a prior selector_not_found')
    )

    await expect(
      launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent('workspace-1', 'claude')
      )
    ).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(callStructuredAgentSession).toHaveBeenCalledOnce()
  })

  /** Codex's support answer is settled by the launch route and owned elsewhere; this pins that the
   *  Claude probe did not change Codex's wire traffic. */
  it('does not probe create support for Codex', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({
      ok: true,
      replayed: false,
      value: { sessionId: 'codex_1', fence: 1 }
    })

    await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-1', 'codex')
    )

    expect(vi.mocked(callStructuredAgentSession).mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create'
    ])
  })

  it('replays the exact create envelope when an unknown outcome is retried', async () => {
    const intent = createStructuredAgentSessionLaunchIntent('workspace-retry', 'codex')
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('response lost'))

    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('response lost')
    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('response lost')

    const first = vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2]
    const second = vi.mocked(callStructuredAgentSession).mock.calls[1]?.[2]
    expect(first).toBe(intent.params)
    expect(second).toBe(first)
    expect(intent.params.envelope.clientOperationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
  })

  it('preserves an unknown refusal code without classifying it as fallback-safe', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may already exist.'
      }
    })

    const error = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-unknown', 'codex')
    ).catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(error).toMatchObject({ code: 'agent_session_operation_unknown' })
    expect(isDefinitiveStructuredAgentSessionCreateError(error)).toBe(false)
  })

  it('preserves a definitive refusal code for the fallback path', async () => {
    vi.mocked(callStructuredAgentSession).mockResolvedValue({
      ok: false,
      refusal: {
        code: 'structured_agent_session_unsupported',
        message: 'Structured chat is unavailable.'
      }
    })

    const error = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-unsupported', 'codex')
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(error).toMatchObject({ code: 'structured_agent_session_unsupported' })
    expect(isDefinitiveStructuredAgentSessionCreateError(error)).toBe(true)
  })

  it.each(['method_not_found', 'structured_agent_session_unsupported'])(
    'turns an old-host %s error into a definitive transport refusal',
    async (code) => {
      vi.mocked(callStructuredAgentSession).mockRejectedValueOnce(
        Object.assign(new Error(code), { code })
      )
      const oldHostError = await launchStructuredAgentSession(
        createStructuredAgentSessionLaunchIntent(`workspace-old-host-${code}`, 'codex')
      ).catch((caught: unknown) => caught)

      expect(oldHostError).toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
      expect(oldHostError).toMatchObject({ code })
    }
  )

  it('keeps an unclassified transport failure outcome unknown', async () => {
    vi.mocked(callStructuredAgentSession).mockRejectedValueOnce(
      Object.assign(new Error('Connection lost'), { code: 'runtime_error' })
    )
    const transportError = await launchStructuredAgentSession(
      createStructuredAgentSessionLaunchIntent('workspace-offline', 'codex')
    ).catch((caught: unknown) => caught)

    expect(transportError).not.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(isDefinitiveStructuredAgentSessionCreateError(transportError)).toBe(false)
  })
})
