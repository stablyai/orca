import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSend
} from './native-chat-pending-sends'

function userMessage(id: string, text: string, timestamp = 1): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function assistantMessage(id: string, text: string, timestamp = 2): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

const pendingOf = (id: string, text: string): NativeChatPendingSend => ({ id, text, sentAt: 100 })

// Glue fixtures place rows after sentAt; older matching rows must never retire newer sends.
const GLUE_BOUNDARY = assistantMessage('glue-boundary', 'ready', 1000)
const GLUE_SENT_AT = 5000

function gluePending(id: string, text: string): NativeChatPendingSend {
  return {
    id,
    text,
    sentAt: GLUE_SENT_AT,
    afterMessageId: GLUE_BOUNDARY.id,
    afterMessageTimestamp: GLUE_BOUNDARY.timestamp
  }
}

it('preserves legacy image caption matching followed by residual text on the same row', () => {
  const pending = [
    { ...gluePending('image', 'a b'), imagePaths: ['/tmp/a.png'] },
    gluePending('a', 'a'),
    gluePending('b', 'b')
  ]
  const row = userMessage('image-row', 'a b', 6000)
  const messages = [GLUE_BOUNDARY, row]
  expect(pendingSendsAsMessages(pending, messages)).toEqual([])
  const retained = prunePendingSends(pending, messages)
  expect(retained.map((entry) => entry.id)).toEqual(['image', 'a', 'b'])
  expect(
    prunePendingSends(retained, [...messages, assistantMessage('reply', 'done', 6100)])
  ).toEqual([])
})

it('matches a legacy caption after the CLI echoes its attached file path', () => {
  const pending = [{ ...gluePending('image', 'look'), imagePaths: ['/tmp/a.png'] }]
  const messages = [
    GLUE_BOUNDARY,
    userMessage('image-row', '@/tmp/a.png look', 6000),
    assistantMessage('reply', 'done', 6100)
  ]
  expect(prunePendingSends(pending, messages)).toEqual([])
})

it.each([false, true])(
  'requires a real row before skipping an intervening legacy obligation, other row first: %s',
  (first) => {
    const pending = [
      { ...gluePending('image', 'a b'), imagePaths: ['/tmp/a.png'] },
      gluePending('other', 'z'),
      gluePending('a', 'a'),
      gluePending('b', 'b')
    ]
    const x = userMessage('x', 'a b', 6000)
    const z = userMessage('z', 'z', 6000)
    const answer = assistantMessage('reply', 'done', 6100)
    expect(prunePendingSends(pending, [GLUE_BOUNDARY, x, answer]).map((entry) => entry.id)).toEqual(
      ['other', 'a', 'b']
    )
    expect(
      prunePendingSends(pending, [GLUE_BOUNDARY, ...(first ? [z, x] : [x, z]), answer])
    ).toEqual([])
  }
)

describe('glued rapid sends', () => {
  // Every send carries its own boundary, including later sends in a glued row.
  const mixedAgeGlue = (): { messages: NativeChatMessage[]; pending: NativeChatPendingSend[] } => {
    const gluedRow = userMessage('glue-row', 'fix the bug', 6000)
    return {
      messages: [
        GLUE_BOUNDARY,
        gluedRow,
        assistantMessage('glue-answer', 'fixed', 6100),
        userMessage('later-history', 'anything', 6200)
      ],
      pending: [
        gluePending('p1', 'fix the'),
        {
          id: 'p2',
          text: 'bug',
          sentAt: 7000,
          afterMessageId: 'glue-answer',
          afterMessageTimestamp: 6100
        }
      ]
    }
  }

  it('keeps a queued send whose own boundary is newer than the glued row (STA-4477)', () => {
    const { messages, pending } = mixedAgeGlue()

    expect(prunePendingSends(pending, messages)).toEqual(pending)
  })

  // Keep prune and render assertions separate so one failure cannot mask the other regression.
  it('still renders a queued send whose own boundary is newer than the row (STA-4477)', () => {
    const { messages, pending } = mixedAgeGlue()

    expect(pendingSendsAsMessages(pending, messages)).toHaveLength(2)
  })

  it('never glues across a send the row cannot represent (STA-4477)', () => {
    const gluedRow = userMessage('glue-row', 'alpha gamma', 6000)
    const messages = [GLUE_BOUNDARY, gluedRow, assistantMessage('glue-answer', 'ok', 6100)]
    const pending = [
      gluePending('p1', 'alpha'),
      {
        id: 'p2',
        text: 'beta',
        sentAt: 7000,
        afterMessageId: 'glue-row',
        afterMessageTimestamp: 6000
      },
      gluePending('p3', 'gamma')
    ]

    expect(prunePendingSends(pending, messages)).toEqual(pending)
    expect(pendingSendsAsMessages(pending, messages)).toHaveLength(3)
  })

  it('still retires the leading run the glued row did land after (STA-4477)', () => {
    const gluedRow = userMessage('glue-row', 'first second', 6000)
    const messages = [GLUE_BOUNDARY, gluedRow, assistantMessage('glue-answer', 'done', 6100)]
    const third = {
      id: 'p3',
      text: 'third',
      sentAt: 7000,
      afterMessageId: 'glue-row',
      afterMessageTimestamp: gluedRow.timestamp
    }
    const pending = [gluePending('p1', 'first'), gluePending('p2', 'second'), third]

    expect(prunePendingSends(pending, messages)).toEqual([third])
  })
})

describe('pendingSendsAsMessages', () => {
  // Empty-transcript sends cannot compare row boundaries or assume host/client clock alignment (#11519).
  it('retires a send into a settled empty transcript whatever the host clock says', () => {
    const fiveMinutes = 5 * 60_000
    const pending = [
      {
        ...pendingOf('first-send', 'run tests'),
        sentAt: 1_000_000,
        afterMessageId: null,
        afterEmptyTranscriptSessionId: 'session-1'
      }
    ]
    const hostBehind = [
      { ...userMessage('u1', 'run tests'), timestamp: 1_000_000 - fiveMinutes },
      { ...assistantMessage('a1', 'passed'), timestamp: 1_000_000 - fiveMinutes + 10 }
    ]

    expect(pendingSendsAsMessages(pending, hostBehind)).toEqual([])
    expect(prunePendingSends(pending, hostBehind)).toEqual([])
  })

  it('uses the transcript boundary clock after pagination, not the renderer send clock', () => {
    const pending = [
      {
        ...pendingOf('new-send', 'run tests'),
        sentAt: 100_000,
        afterMessageId: 'paged-out-answer',
        afterMessageTimestamp: 20
      }
    ]
    const remoteTranscript = [
      { ...userMessage('new-user', 'run tests'), timestamp: 30 },
      { ...assistantMessage('new-answer', 'passed'), timestamp: 40 }
    ]

    expect(pendingSendsAsMessages(pending, remoteTranscript)).toEqual([])
    expect(prunePendingSends(pending, remoteTranscript)).toEqual([])
  })
})
