import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), handBack: vi.fn(() => true) }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  structuredAgentSessionHostSupports: vi.fn(async () => true)
}))
vi.mock('./structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))

import {
  dropStructuredAgentSessionSends,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  stopStructuredAgentSessionSends
} from './structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { getStructuredAgentSessionSendNotice } from './structured-agent-session-pending-sends'
import type { StructuredAgentSessionAttachmentPreparation } from './structured-agent-session-send-slot'

const sessionId = 'preparing-attachments'
const input = {
  sessionId,
  target: { kind: 'local' } as const,
  text: '$review check this',
  attachments: [{ path: '/client/shot.png', previewUri: '' }],
  skills: [{ name: 'review', path: '/repo/review/SKILL.md' }]
}

function prepare() {
  const result =
    Promise.withResolvers<Awaited<ReturnType<StructuredAgentSessionAttachmentPreparation>>>()
  return { ...result, callback: vi.fn(() => result.promise) }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('attachment preparation owns a cancellable send', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.call.mockReset().mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_conflict',
        message: 'busy',
        details: { reason: 'chatStarting' }
      }
    })
    mocks.handBack.mockClear()
    noteStructuredAgentSessionFence(sessionId, 1)
  })
  afterEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.useRealTimers()
  })

  it.each(['stop', 'close'] as const)(
    'never issues a send when %s happens during the upload',
    async (action) => {
      const upload = prepare()
      const sent = sendStructuredAgentSessionMessage({
        ...input,
        prepareAttachments: upload.callback
      })!
      expect(sendStructuredAgentSessionMessage({ ...input, text: 'later' })).toBeNull()
      if (action === 'stop') {
        stopStructuredAgentSessionSends(sessionId)
      } else {
        dropStructuredAgentSessionSends(sessionId)
      }
      expect(await sent.outcome).toBe(action === 'stop' ? 'returned' : 'dropped')
      upload.resolve({
        text: input.text,
        attachments: [{ path: '/host/shot.png', previewUri: '' }]
      })
      await flush()
      expect(mocks.call).not.toHaveBeenCalled()
      expect(mocks.handBack).toHaveBeenCalledTimes(action === 'stop' ? 1 : 0)
      if (action === 'stop') {
        expect(mocks.handBack).toHaveBeenCalledWith(
          sessionId,
          sent.clientMessageId,
          expect.objectContaining({
            skills: input.skills,
            blocks: [
              { type: 'text', text: input.text },
              { type: 'image-ref', path: '/client/shot.png' }
            ]
          }),
          undefined,
          undefined
        )
      }
    }
  )

  it('sends the prepared paths with the same message identity and skills', async () => {
    const upload = prepare()
    const onCreated = vi.fn()
    const sent = sendStructuredAgentSessionMessage({
      ...input,
      onCreated,
      prepareAttachments: upload.callback
    })!
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(sent.clientMessageId)
    expect(mocks.call).not.toHaveBeenCalled()
    upload.resolve({ text: input.text, attachments: [{ path: '/host/shot.png', previewUri: '' }] })
    expect(await sent.outcome).toBe('returned')
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const params = mocks.call.mock.calls[0][2]
    expect(params.envelope.clientOperationId).toBe(sent.clientMessageId)
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(params.body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: input.text },
        { type: 'image-ref', path: '/host/shot.png' }
      ],
      skills: input.skills
    })
  })

  it('returns the original input with the upload error and frees the send slot', async () => {
    const upload = prepare()
    const sent = sendStructuredAgentSessionMessage({
      ...input,
      prepareAttachments: upload.callback
    })!
    upload.reject(new Error('Upload disconnected'))
    expect(await sent.outcome).toBe('returned')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(getStructuredAgentSessionSendNotice(sessionId)).toBe('Upload disconnected')
    expect(mocks.handBack).toHaveBeenCalledWith(
      sessionId,
      sent.clientMessageId,
      expect.objectContaining({ skills: input.skills }),
      undefined,
      undefined
    )
    const next = sendStructuredAgentSessionMessage({ ...input, text: 'retry' })
    expect(next).not.toBeNull()
    await next!.outcome
  })
})
