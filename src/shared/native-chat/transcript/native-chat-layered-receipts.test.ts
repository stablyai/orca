import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { NativeChatSourceContext } from '../input/native-chat-prompt-observation'
import type { NativeChatMessage } from '../native-chat-types'
import {
  prunePendingSends,
  visibleNativeChatPendingSends,
  type NativeChatPendingSend
} from './native-chat-pending-sends'

const context: NativeChatSourceContext = {
  owner: 'read-A',
  sessionId: 'A',
  targetPtyId: 'pty',
  runtimeEnvironmentId: null
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const observation = {
  origin: 'hook' as const,
  authorityId: 'host',
  incarnation: 1,
  revision: 2,
  observedAt: 10
}
function send(id: string, text: string): NativeChatPendingSend {
  return {
    id,
    text,
    sourceAgent: 'codex',
    sentAt: 1,
    sourceContext: context,
    promptBinding: {
      runtimeId: 'host',
      ptyId: 'pty',
      generation: 1,
      processIncarnation: 'pty:1',
      terminalHandle: 'terminal',
      targetPtyId: 'pty',
      runtimeEnvironmentId: null
    },
    promptSubmission: {
      observation,
      sessionId: 'A',
      textDigest: digest(text),
      connectionId: null,
      process: { pid: 42, platform: 'linux', startTime: '1' }
    }
  }
}
function row(id: string, text: string, order: number, retained = false): NativeChatMessage {
  return {
    id,
    role: 'user',
    source: 'transcript',
    timestamp: null,
    transcriptOrder: order,
    blocks: [{ type: 'text', text }],
    ...(retained
      ? {
          inputContent: {
            provider: 'codex' as const,
            textDigest: digest(text),
            images: [],
            retained: true as const
          }
        }
      : {})
  }
}
const answer: NativeChatMessage = {
  id: 'answer',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  transcriptOrder: 10,
  blocks: []
}

it('allocates all main alternatives jointly with exact hook evidence', () => {
  const x = { ...send('x', 'repeat'), matchingOccurrence: 1 }
  const y = { ...send('y', 'repeat'), matchingOccurrence: 2 }
  expect(
    prunePendingSends(
      [x, y],
      [row('u1', 'repeat', 1, true), row('u2', 'repeat', 2), answer],
      'A',
      context
    )
  ).toEqual([])
  expect(
    prunePendingSends(
      [send('a', 'a'), send('b', 'b')],
      [row('a', 'a', 1, true), row('ab', 'a b', 2), answer],
      'A',
      context
    )
  ).toEqual([])
})

it('keeps the earliest row for a submitted input while its identical successor is dispatching', () => {
  const x = { ...send('x', 'repeat'), matchingOccurrence: 1 }
  const y = { ...send('y', 'repeat'), matchingOccurrence: 2, dispatchPending: true as const }
  const messages = [row('u1', 'repeat', 1), row('u2', 'repeat', 2, true)]
  const pending = prunePendingSends([x, y], messages, 'A', context)
  expect(pending.map((entry) => [entry.id, entry.sourceReceipt?.id])).toEqual([
    ['x', 'u1'],
    ['y', undefined]
  ])
  expect(
    prunePendingSends(
      pending.map((entry) => ({ ...entry, dispatchPending: undefined })),
      [...messages, answer],
      'A',
      context
    )
  ).toEqual([])
})

it.each(['ready', 'loading', 'unknown', 'reader-replaced'] as const)(
  'keeps a spent row excluded when a rank-two successor gains evidence after %s context',
  (phase) => {
    const x = { ...send('x', 'repeat'), matchingOccurrence: 1 }
    const y = {
      ...send('y', 'repeat'),
      matchingOccurrence: 2,
      dispatchPending: true as const,
      promptBinding: undefined,
      promptSubmission: undefined,
      ...(phase === 'unknown' || phase === 'reader-replaced' ? { sourceContext: undefined } : {})
    }
    const messages = [row('u1', 'repeat', 1, true), answer]
    const pending = prunePendingSends(
      [x, y],
      messages,
      'A',
      phase === 'ready' || phase === 'reader-replaced' ? context : undefined
    )
    expect(pending.map((entry) => entry.id)).toEqual(['y'])
    const recovered = phase === 'reader-replaced' ? { ...context, owner: 'read-B' } : context
    const evidence = send('y', 'repeat')
    const completed = pending.map((entry) => ({
      ...entry,
      dispatchPending: undefined,
      promptBinding: evidence.promptBinding,
      promptSubmission: evidence.promptSubmission
    }))
    expect(prunePendingSends(completed, messages, 'A', recovered).map((entry) => entry.id)).toEqual(
      ['y']
    )
    expect(
      prunePendingSends(
        completed,
        [
          ...messages,
          row('u2', 'repeat', 11, true),
          { ...answer, id: 'answer-2', transcriptOrder: 12 }
        ],
        'A',
        recovered
      )
    ).toEqual([])
  }
)

it('keeps an existing legacy spent-row exclusion when the successor becomes source-qualified', () => {
  const x = send('x', 'repeat')
  const y = {
    ...send('y', 'repeat'),
    matchingOccurrence: 1,
    dispatchPending: true as const,
    promptBinding: undefined,
    promptSubmission: undefined
  }
  const messages = [row('u1', 'repeat', 1, true), answer]
  const pending = prunePendingSends([x, y], messages, 'A')
  expect(pending.map((entry) => entry.id)).toEqual(['y'])
  const evidence = send('y', 'repeat')
  const completed = pending.map((entry) => ({
    ...entry,
    dispatchPending: undefined,
    promptBinding: evidence.promptBinding,
    promptSubmission: evidence.promptSubmission
  }))
  expect(prunePendingSends(completed, messages, 'A', context).map((entry) => entry.id)).toEqual([
    'y'
  ])
  expect(
    prunePendingSends(
      completed,
      [
        ...messages,
        row('u2', 'repeat', 11, true),
        { ...answer, id: 'answer-2', transcriptOrder: 12 }
      ],
      'A',
      context
    )
  ).toEqual([])
})

it('retires rejected non-source input when the user later submits the retained terminal text', () => {
  const rejected = { ...send('x', 'repeat'), delivery: 'rejected' as const }
  const messages = [row('u1', 'repeat', 1), answer]
  expect(
    prunePendingSends([{ ...rejected, sourceAgent: undefined }], messages, 'A', context)
  ).toEqual([])
  expect(prunePendingSends([rejected], messages, 'A', context).map((entry) => entry.id)).toEqual([
    'x'
  ])
})

it('uses current-session main matching when optional metadata is absent or its source changed', () => {
  const x = {
    ...send('x', 'repeat'),
    afterMessageId: null,
    afterEmptyTranscriptSessionId: 'A',
    sourceBoundary: {
      sessionId: 'A',
      owner: 'read-A',
      id: 'old',
      timestamp: null,
      position: { kind: 'order' as const, value: 100 }
    }
  }
  const current = [row('new', 'repeat', 1), answer]
  expect(
    prunePendingSends([x], current, 'B', { ...context, owner: 'read-B', sessionId: 'B' })
  ).toEqual([])
  expect(
    prunePendingSends(
      [{ ...x, promptBinding: undefined, promptSubmission: undefined }],
      current,
      'A'
    )
  ).toEqual([])
})

it('requires retained provenance and definite submission only for stronger proof', () => {
  const x = { ...send('x', 'repeat'), matchingOccurrence: 2 }
  const messages = [row('u', 'repeat', 1, true), answer]
  expect(prunePendingSends([x], messages, 'A', context)).toEqual([])
  expect(
    prunePendingSends([{ ...x, writeUnconfirmedAt: 1 }], messages, 'A', context).map(
      (entry) => entry.id
    )
  ).toEqual(['x'])
  expect(
    prunePendingSends([x], [row('u', 'repeat', 1), answer], 'A', context).map((entry) => entry.id)
  ).toEqual(['x'])
  expect(
    prunePendingSends([x], messages, 'A', { ...context, targetPtyId: 'other' }).map(
      (entry) => entry.id
    )
  ).toEqual(['x'])
})

it('keeps source position domains separate while retaining strict, inclusive and null clock windows', () => {
  const entry: NativeChatPendingSend = {
    ...send('position', 'repeat'),
    sentAt: 1000,
    afterMessageId: 'paged-boundary',
    afterMessageTimestamp: 1000,
    sourceBoundary: {
      sessionId: 'A',
      owner: context.owner,
      id: 'paged-boundary',
      timestamp: 1000,
      position: { kind: 'order', value: 10 }
    }
  }
  const ordered = { ...row('u', 'repeat', 11, true), timestamp: 999 }
  const orderedAnswer = { ...answer, transcriptOrder: 12, timestamp: 998 }
  expect(prunePendingSends([entry], [ordered, orderedAnswer], 'A', context)).toEqual([])
  const offset = { ...ordered, transcriptOrder: undefined, transcriptOffset: 11 }
  const offsetAnswer = { ...orderedAnswer, transcriptOrder: undefined, transcriptOffset: 12 }
  expect(
    prunePendingSends([entry], [offset, offsetAnswer], 'A', context).map((pending) => pending.id)
  ).toEqual(['position'])
  expect(
    prunePendingSends(
      [entry],
      [
        { ...offset, timestamp: 1001 },
        { ...offsetAnswer, timestamp: 1002 }
      ],
      'A',
      context
    )
  ).toEqual([])
  expect(
    visibleNativeChatPendingSends([entry], [{ ...offset, timestamp: 1000 }], 'A', context).map(
      (pending) => pending.id
    )
  ).toEqual(['position'])
  const local = { ...entry, sourceBoundary: undefined, afterMessageTimestamp: null }
  expect(
    prunePendingSends(
      [local],
      [
        { ...offset, timestamp: 1000 },
        { ...offsetAnswer, timestamp: 1000 }
      ],
      'A',
      context
    )
  ).toEqual([])
  expect(
    prunePendingSends(
      [entry],
      [
        { ...offset, timestamp: null },
        { ...offsetAnswer, timestamp: null }
      ],
      'A',
      context
    )
  ).toEqual([])
})
