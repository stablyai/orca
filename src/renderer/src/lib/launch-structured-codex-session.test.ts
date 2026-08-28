import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { launchStructuredCodexSession } from './launch-structured-codex-session'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

describe('structured Codex launch', () => {
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
        snapshot: { cursor: { epoch: 'epoch-1', sequence: 0 }, items: [] },
        unconfirmedClientMessageIds: []
      }
    }))

    const sessionId = await launchStructuredCodexSession('workspace-1')
    const params = vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2] as {
      envelope: { sessionId: string; payloadFingerprint: string }
      worktree: string
      agent: 'codex'
    }

    expect(sessionId).toMatch(/^codex_[A-Za-z0-9_]{36}$/)
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
  })
})
