import { describe, expect, it } from 'vitest'
import { retainPendingSendsForConversation } from './native-chat-pending-conversation'
import { pendingSendsAsMessages } from './native-chat-pending'
import type { NativeChatCommandMarker, NativeChatPendingSend } from './native-chat-pending'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

function pendingOf(
  id: string,
  overrides: Partial<NativeChatPendingSend> = {}
): NativeChatPendingSend {
  return { id, text: `text-${id}`, sentAt: 100, ...overrides }
}

function clearMarker(sentAt: number): NativeChatCommandMarker {
  return { id: `marker-${sentAt}`, command: '/clear', sentAt }
}

const noMarkers: readonly NativeChatCommandMarker[] = []

describe('retainPendingSendsForConversation', () => {
  it('returns the same reference when nothing changes', () => {
    const pending = [pendingOf('p1', { sessionId: 's1' })]
    expect(
      retainPendingSendsForConversation(pending, { sessionId: 's1', markers: noMarkers })
    ).toBe(pending)
  })

  it('drops an echo issued into a replaced provider session', () => {
    const pending = [pendingOf('p1', { sessionId: 's1' }), pendingOf('p2', { sessionId: 's2' })]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: 's2',
      markers: noMarkers
    })
    expect(next.map((entry) => entry.id)).toEqual(['p2'])
  })

  it('adopts the first session id for echoes sent before it was known', () => {
    const pending = [pendingOf('p1'), pendingOf('p2', { sessionId: null })]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: 's1',
      markers: noMarkers
    })
    expect(next.map((entry) => entry.sessionId)).toEqual(['s1', 's1'])
  })

  it('keeps echoes while the provider session is momentarily unknown', () => {
    const pending = [pendingOf('p1', { sessionId: 's1' })]
    expect(
      retainPendingSendsForConversation(pending, { sessionId: null, markers: noMarkers })
    ).toBe(pending)
  })

  it('drops echoes queued before the latest /clear', () => {
    const pending = [
      pendingOf('p1', { sentAt: 100, sessionId: 's1' }),
      pendingOf('p2', { sentAt: 300, sessionId: 's1' })
    ]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: 's1',
      markers: [clearMarker(200)]
    })
    expect(next.map((entry) => entry.id)).toEqual(['p2'])
  })

  it('ignores non-clear command markers', () => {
    const pending = [pendingOf('p1', { sentAt: 100, sessionId: 's1' })]
    const markers = [{ id: 'm1', command: '/model opus', sentAt: 200 }]
    expect(retainPendingSendsForConversation(pending, { sessionId: 's1', markers })).toBe(pending)
  })

  it('drops pre-clear echoes even while the session id is unknown', () => {
    const pending = [pendingOf('p1', { sentAt: 100 })]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: null,
      markers: [clearMarker(200)]
    })
    expect(next).toEqual([])
  })

  it('stops a replaced conversation from rendering the old prompt as the newest bubble', () => {
    const pending = [pendingOf('p1', { text: 'summarize the diff', sessionId: 's1' })]
    const replacedTranscript: NativeChatMessage[] = [
      {
        id: 'm1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        timestamp: 500,
        source: 'transcript'
      },
      {
        id: 'm2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }],
        timestamp: 600,
        source: 'transcript'
      }
    ]
    // The old echo can never match the new session's transcript, so without the
    // conversation filter it renders after every real turn, forever.
    expect(pendingSendsAsMessages(pending, replacedTranscript)).toHaveLength(1)
    const retained = retainPendingSendsForConversation(pending, {
      sessionId: 's2',
      markers: noMarkers
    })
    expect(pendingSendsAsMessages(retained, replacedTranscript)).toEqual([])
  })
})
