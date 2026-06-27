import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  clearCommandMarkerCacheForTests,
  commandMarkersAsMessages,
  isCommandMarkerId,
  isPendingMessageId,
  pendingSendsAsMessages,
  prunePendingSends,
  readCommandMarkerCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import { stripNoiseMessages } from './native-chat-noise'

function userMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function assistantMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
    source: 'transcript'
  }
}

const pendingOf = (id: string, text: string): NativeChatPendingSend => ({ id, text, sentAt: 100 })

describe('prunePendingSends', () => {
  it('returns the same reference when there is nothing pending', () => {
    const pending: NativeChatPendingSend[] = []
    expect(prunePendingSends(pending, [userMessage('m1', 'hi')])).toBe(pending)
  })

  it('drops a pending send once its user turn lands in the transcript', () => {
    const pending = [pendingOf('p1', 'fix the bug')]
    const next = prunePendingSends(pending, [userMessage('m1', 'fix the bug')])
    expect(next).toEqual([])
  })

  it('matches ignoring surrounding/collapsed whitespace', () => {
    const pending = [pendingOf('p1', '  do   the   thing ')]
    const next = prunePendingSends(pending, [userMessage('m1', 'do the thing')])
    expect(next).toEqual([])
  })

  it('keeps a pending send that has not landed yet', () => {
    const pending = [pendingOf('p1', 'not yet')]
    const next = prunePendingSends(pending, [assistantMessage('m1', 'working on it')])
    expect(next).toBe(pending)
  })

  it('does not match an assistant message with the same text', () => {
    const pending = [pendingOf('p1', 'echo me')]
    const next = prunePendingSends(pending, [assistantMessage('m1', 'echo me')])
    expect(next).toBe(pending)
  })

  it('prunes only the matched entry, keeping others', () => {
    const pending = [pendingOf('p1', 'first'), pendingOf('p2', 'second')]
    const next = prunePendingSends(pending, [userMessage('m1', 'first')])
    expect(next).toEqual([pendingOf('p2', 'second')])
  })
})

describe('pendingSendsAsMessages', () => {
  it('maps pending sends to prefixed scrape-source user messages sorted by sentAt', () => {
    const messages = pendingSendsAsMessages([{ id: 'p1', text: 'queued text', sentAt: 42 }])
    expect(messages).toEqual([
      {
        id: 'pending:p1',
        role: 'user',
        blocks: [{ type: 'text', text: 'queued text' }],
        timestamp: 42,
        source: 'scrape'
      }
    ])
  })
})

describe('isPendingMessageId', () => {
  it('recognizes the pending id prefix', () => {
    expect(isPendingMessageId('pending:p1')).toBe(true)
    expect(isPendingMessageId('transcript-123')).toBe(false)
  })
})

describe('commandMarkersAsMessages', () => {
  it('renders a slash command as a system "Ran <cmd>" message', () => {
    expect(commandMarkersAsMessages([{ id: 'c1', command: '/clear', sentAt: 7 }])).toEqual([
      {
        id: 'command:c1',
        role: 'system',
        blocks: [{ type: 'text', text: 'Ran /clear' }],
        timestamp: 7,
        source: 'scrape'
      }
    ])
  })

  it('survives stripNoiseMessages (the "Ran" text is not a noise prefix)', () => {
    const markers = commandMarkersAsMessages([{ id: 'c1', command: '/compact', sentAt: 1 }])
    expect(stripNoiseMessages(markers)).toEqual(markers)
  })

  it('isCommandMarkerId recognizes the prefix', () => {
    expect(isCommandMarkerId('command:c1')).toBe(true)
    expect(isCommandMarkerId('pending:p1')).toBe(false)
  })
})

describe('command marker cache', () => {
  it('persists slash command markers for the same pane conversation', () => {
    clearCommandMarkerCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex', sessionId: 'session-1' }

    const appended = appendCommandMarkerCache(scope, '/clear', 10)

    expect(appended).toEqual([{ id: '10-1', command: '/clear', sentAt: 10 }])
    expect(readCommandMarkerCache(scope)).toEqual(appended)
    expect(readCommandMarkerCache({ ...scope, sessionId: 'session-2' })).toEqual([])
  })

  it('caps cached command markers to the latest eight', () => {
    clearCommandMarkerCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'claude', sessionId: 'session-1' }

    for (let i = 0; i < 10; i += 1) {
      appendCommandMarkerCache(scope, `/cmd-${i}`, i)
    }

    expect(readCommandMarkerCache(scope).map((marker) => marker.command)).toEqual([
      '/cmd-2',
      '/cmd-3',
      '/cmd-4',
      '/cmd-5',
      '/cmd-6',
      '/cmd-7',
      '/cmd-8',
      '/cmd-9'
    ])
  })
})

describe('applyCommandMarkerBoundaries', () => {
  it('hides existing transcript messages after a local /clear marker', () => {
    const messages = [
      userMessage('before', 'old prompt'),
      { ...assistantMessage('after', 'new answer'), timestamp: 20 }
    ]

    expect(
      applyCommandMarkerBoundaries(messages, [{ id: 'c1', command: '/clear', sentAt: 10 }])
    ).toEqual([{ ...assistantMessage('after', 'new answer'), timestamp: 20 }])
  })

  it('keeps messages for non-clear commands like /compact', () => {
    const messages = [userMessage('before', 'old prompt')]

    expect(
      applyCommandMarkerBoundaries(messages, [{ id: 'c1', command: '/compact', sentAt: 10 }])
    ).toBe(messages)
  })

  it('uses the latest clear marker as the visible boundary', () => {
    const messages = [
      { ...userMessage('old', 'old'), timestamp: 5 },
      { ...userMessage('middle', 'middle'), timestamp: 15 },
      { ...userMessage('new', 'new'), timestamp: 25 }
    ]

    expect(
      applyCommandMarkerBoundaries(messages, [
        { id: 'c1', command: '/clear', sentAt: 10 },
        { id: 'c2', command: '/clear', sentAt: 20 }
      ]).map((message) => message.id)
    ).toEqual(['new'])
  })
})
