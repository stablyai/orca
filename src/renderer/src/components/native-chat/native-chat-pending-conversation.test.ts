import { describe, expect, it } from 'vitest'
import { retainPendingSendsForConversation } from './native-chat-pending-conversation'
import { pendingSendsAsMessages, prunePendingSends } from './native-chat-pending'
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

  it('renumbers survivors so a dropped echo does not strand the one after it', () => {
    // `assignNativeChatPendingOccurrence` numbers a repeat send past its
    // predecessors, which is right when a real turn consumed the earlier one. A
    // conversation swap consumes nothing, so the survivor has to count from 1 or
    // it waits forever for a second identical turn that will never arrive.
    const pending = [
      pendingOf('p1', { sentAt: 100, sessionId: 's1', text: 'continue' }),
      pendingOf('p2', {
        sentAt: 200,
        sessionId: 's1',
        text: 'continue',
        matchingOccurrence: 2
      })
    ]
    const markers = [clearMarker(150)]
    const next = retainPendingSendsForConversation(pending, { sessionId: 's1', markers })
    expect(next.map((entry) => entry.id)).toEqual(['p2'])
    expect(next[0]?.matchingOccurrence).toBe(1)

    // The replacement conversation answers "continue" exactly once, which is all
    // the survivor is owed.
    const replaced: NativeChatMessage[] = [
      {
        id: 'm1',
        role: 'user',
        blocks: [{ type: 'text', text: 'continue' }],
        timestamp: 500,
        source: 'transcript'
      },
      {
        id: 'm2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'ok' }],
        timestamp: 600,
        source: 'transcript'
      }
    ]
    expect(prunePendingSends(next, replaced)).toEqual([])
    expect(pendingSendsAsMessages(next, replaced)).toEqual([])
  })

  it('does not renumber when the only change is adopting the first session id', () => {
    // A capped-out predecessor's send still landed, so its turn still consumes an
    // occurrence. Adoption drops nothing, so renumbering would strand the survivor
    // on an already-consumed turn.
    const pending = [
      pendingOf('p1', { sentAt: 100, text: 'ping', matchingOccurrence: 2 }),
      pendingOf('p2', { sentAt: 200, text: 'ping', matchingOccurrence: 3 })
    ]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: 's1',
      markers: noMarkers
    })
    expect(next.map((entry) => [entry.sessionId, entry.matchingOccurrence])).toEqual([
      ['s1', 2],
      ['s1', 3]
    ])
  })

  it('keeps distinct texts independent when renumbering', () => {
    const pending = [
      pendingOf('p1', { sentAt: 100, sessionId: 's1', text: 'alpha' }),
      pendingOf('p2', { sentAt: 200, sessionId: 's1', text: 'beta' }),
      pendingOf('p3', { sentAt: 300, sessionId: 's1', text: 'alpha', matchingOccurrence: 2 })
    ]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: 's1',
      markers: [clearMarker(150)]
    })
    // 'beta' had no sibling dropped, so it keeps its untouched slot — undefined
    // resolves to occurrence 1 through `nativeChatPendingOccurrence`.
    expect(next.map((entry) => [entry.id, entry.matchingOccurrence])).toEqual([
      ['p2', undefined],
      ['p3', 1]
    ])
  })

  it('leaves an unrelated key alone when a different key is dropped', () => {
    // 'ping' holds occurrence 2 because its predecessor was pruned by a real
    // landed turn, which is still in the transcript. Dropping an unrelated echo
    // frees no 'ping' slot, so renumbering it down would retire it early.
    const pending = [
      pendingOf('p1', { sentAt: 50, sessionId: 's0', text: 'stale prompt' }),
      pendingOf('p2', { sentAt: 300, sessionId: null, text: 'ping', matchingOccurrence: 2 })
    ]
    const next = retainPendingSendsForConversation(pending, {
      sessionId: 's1',
      markers: noMarkers
    })
    expect(next.map((entry) => [entry.id, entry.matchingOccurrence])).toEqual([['p2', 2]])
  })
})
