import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  createStructuredCodexSessionLaunchIntent,
  launchStructuredCodexSession
} from './launch-structured-codex-session'

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

    const intent = createStructuredCodexSessionLaunchIntent('workspace-1')
    const sessionId = await launchStructuredCodexSession(intent)
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
    expect(params).toBe(intent.params)
  })

  it('replays the exact create envelope when an unknown outcome is retried', async () => {
    const intent = createStructuredCodexSessionLaunchIntent('workspace-retry')
    vi.mocked(callStructuredAgentSession).mockRejectedValue(new Error('response lost'))

    await expect(launchStructuredCodexSession(intent)).rejects.toThrow('response lost')
    await expect(launchStructuredCodexSession(intent)).rejects.toThrow('response lost')

    const first = vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2]
    const second = vi.mocked(callStructuredAgentSession).mock.calls[1]?.[2]
    expect(first).toBe(intent.params)
    expect(second).toBe(first)
    expect(intent.params.envelope.clientOperationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
  })
})
