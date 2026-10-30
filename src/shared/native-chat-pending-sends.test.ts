import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  isPendingMessageId,
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

function imageMessage(id: string, ...paths: string[]): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: paths.map((path) => ({ type: 'image-ref' as const, path })),
    timestamp: 1,
    source: 'transcript'
  }
}

const pendingOf = (id: string, text: string): NativeChatPendingSend => ({ id, text, sentAt: 100 })

describe('prunePendingSends', () => {
  it.each(['/remote/.orca/drops/Screenshot 2026-09-20 at 18.25.43.png', '/tmp/local photo.png'])(
    'reconciles a pasted attachment path recorded as text: %s',
    (path) => {
      const pending = [
        { ...pendingOf('pending', '看一下'), imagePaths: [path], afterMessageId: null }
      ]
      const user = userMessage('real', `${path} 看一下`, 101)
      expect(pendingSendsAsMessages(pending, [user])).toEqual([])
      expect(prunePendingSends(pending, [user])).toEqual(pending)
      expect(prunePendingSends(pending, [user, assistantMessage('reply', '好的', 102)])).toEqual([])
      expect(
        prunePendingSends(pending, [
          userMessage('unrelated', `${path}.other 看一下`, 101),
          assistantMessage('reply', 'ok', 102)
        ])
      ).toEqual(pending)
    }
  )

  it('reconciles image-only and multiple attachments without consuming a prior turn', () => {
    const paths = ['/remote/a.png', '/remote/b.png']
    const pending = [{ ...pendingOf('pending', ''), imagePaths: paths, afterMessageId: 'old' }]
    const old = userMessage('old', paths.join(' '), 99)
    expect(prunePendingSends(pending, [old, assistantMessage('old-reply', 'old', 100)])).toEqual(
      pending
    )
    const messages = [
      old,
      userMessage('new', paths.join(''), 101),
      assistantMessage('reply', 'ok', 102)
    ]
    expect(prunePendingSends(pending, messages)).toEqual([])
  })
  it('returns the same reference when there is nothing pending', () => {
    const pending: NativeChatPendingSend[] = []
    expect(prunePendingSends(pending, [userMessage('m1', 'hi')])).toBe(pending)
  })

  it('keeps a pending send while only its user turn has landed', () => {
    const pending = [pendingOf('p1', 'fix the bug')]
    const next = prunePendingSends(pending, [userMessage('m1', 'fix the bug')])
    expect(next).toBe(pending)
  })

  it('drops a pending send once the transcript advances beyond its user turn', () => {
    const pending = [pendingOf('p1', 'fix the bug')]
    const next = prunePendingSends(pending, [
      userMessage('m1', 'fix the bug'),
      assistantMessage('m2', 'working on it')
    ])
    expect(next).toEqual([])
  })

  it('matches advanced turns ignoring surrounding/collapsed whitespace', () => {
    const pending = [pendingOf('p1', '  do   the   thing ')]
    const next = prunePendingSends(pending, [
      userMessage('m1', 'do the thing'),
      assistantMessage('m2', 'done')
    ])
    expect(next).toEqual([])
  })

  it('drops an attachment pending send once a prefixed transcript prompt advances', () => {
    const pending = [
      { ...pendingOf('p1', 'what do you see'), imagePaths: ['/Users/me/Downloads/3d.png'] }
    ]
    const next = prunePendingSends(pending, [
      userMessage('m1', '[Image #1] what do you see'),
      assistantMessage('m2', 'an image')
    ])
    expect(next).toEqual([])
  })

  it('drops an attachment pending send once a trailing-marker prompt advances', () => {
    const pending = [
      { ...pendingOf('p1', 'what do you see'), imagePaths: ['/Users/me/Downloads/3d.png'] }
    ]
    const next = prunePendingSends(pending, [
      userMessage('m1', 'what do you see[Image #1]'),
      assistantMessage('m2', 'an image')
    ])
    expect(next).toEqual([])
  })

  it('drops a pending send represented by multiple marker-bearing text blocks', () => {
    const prompt: NativeChatMessage = {
      ...userMessage('m1', 'unused'),
      blocks: [
        { type: 'text', text: 'what do' },
        { type: 'image-ref', path: '/tmp/a.png' },
        { type: 'text', text: '[Image #1] you see' }
      ]
    }
    const next = prunePendingSends(
      [pendingOf('p1', 'what do you see')],
      [prompt, assistantMessage('m2', 'an image')]
    )

    expect(next).toEqual([])
  })

  it('drops an attachment-only pending send once its image turn advances', () => {
    const pending = [{ ...pendingOf('p1', ''), imagePaths: ['/tmp/first.png', '/tmp/second.png'] }]
    const transcript = [
      imageMessage('m1', '/tmp/first.png', '/tmp/second.png'),
      assistantMessage('m2', 'two images')
    ]

    expect(prunePendingSends(pending, transcript)).toEqual([])
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
    const next = prunePendingSends(pending, [
      userMessage('m1', 'first'),
      assistantMessage('m2', 'first answer')
    ])
    expect(next).toEqual([pendingOf('p2', 'second')])
  })

  it('does not prune a repeated prompt against a turn before its send boundary', () => {
    const oldUser = userMessage('old-user', 'run tests')
    const oldAnswer = assistantMessage('old-answer', 'passed')
    const pending = [{ ...pendingOf('new-send', 'run tests'), afterMessageId: oldAnswer.id }]

    expect(prunePendingSends(pending, [oldUser, oldAnswer])).toEqual(pending)
  })

  it('prunes a first send against a timestampless transcript turn (grok)', () => {
    const pending = [{ ...pendingOf('p1', 'rename it'), afterMessageId: null }]
    const transcript = [
      { ...userMessage('u1', 'rename it'), timestamp: null },
      { ...assistantMessage('a1', 'done'), timestamp: null }
    ]

    expect(prunePendingSends(pending, transcript)).toEqual([])
  })

  it('prunes only one of two identical pending sends for one completed turn', () => {
    const pending = [pendingOf('p1', 'repeat'), pendingOf('p2', 'repeat')]
    expect(
      prunePendingSends(pending, [userMessage('u1', 'repeat'), assistantMessage('a1', 'done')])
    ).toEqual([pendingOf('p2', 'repeat')])
  })

  it('does not treat an unrelated longer user turn as a glued match', () => {
    const pending = [pendingOf('p1', 'hi')]
    expect(
      prunePendingSends(pending, [
        userMessage('u1', 'history of the project'),
        assistantMessage('a1', 'ok')
      ])
    ).toEqual(pending)
  })
})

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

function glueTranscript(row: string): NativeChatMessage[] {
  return [
    userMessage('glue-history', 'hello', 900),
    GLUE_BOUNDARY,
    userMessage('glue-row', row, 6000)
  ]
}

function advancedGlueTranscript(row: string): NativeChatMessage[] {
  return [...glueTranscript(row), assistantMessage('glue-answer', 'done', 6100)]
}

describe('glued rapid sends', () => {
  it('retires both echoes when a lost Enter glued the pair into one row', () => {
    const pending = [gluePending('p1', 'tell me a joke'), gluePending('p2', 'continue')]

    expect(prunePendingSends(pending, advancedGlueTranscript('tell me a jokecontinue'))).toEqual([])
  })

  it('hides both echoes as soon as the glued row lands, before the reply', () => {
    const pending = [gluePending('p1', 'tell me a joke'), gluePending('p2', 'continue')]

    expect(pendingSendsAsMessages(pending, glueTranscript('tell me a jokecontinue'))).toEqual([])
  })

  it('retires a pair the agent glued with a separator of its own', () => {
    const pending = [gluePending('p1', 'tell me a joke'), gluePending('p2', 'continue')]

    expect(prunePendingSends(pending, advancedGlueTranscript('tell me a joke continue'))).toEqual(
      []
    )
  })

  it('retires a pair whose glued row separates with tabs and newlines', () => {
    const pending = [gluePending('p1', 'tell me a joke'), gluePending('p2', 'continue')]

    expect(
      prunePendingSends(pending, advancedGlueTranscript('tell me a joke \t\n continue'))
    ).toEqual([])
  })

  it('retires three prompts collapsed into one row with mixed boundaries', () => {
    const pending = [
      gluePending('p1', 'first'),
      gluePending('p2', 'second'),
      gluePending('p3', 'third')
    ]

    expect(prunePendingSends(pending, advancedGlueTranscript('firstsecond third'))).toEqual([])
  })

  it('retires prompts that themselves contain the separator', () => {
    const pending = [gluePending('p1', 'fix the bug'), gluePending('p2', 'then run the tests')]

    expect(
      prunePendingSends(pending, advancedGlueTranscript('fix the bug then run the tests'))
    ).toEqual([])
  })

  it('retires an identical prompt sent twice', () => {
    const pending = [gluePending('p1', 'repeat'), gluePending('p2', 'repeat')]

    expect(prunePendingSends(pending, advancedGlueTranscript('repeat repeat'))).toEqual([])
  })

  it('retires an identical prompt sent three times', () => {
    const pending = [gluePending('p1', 'ha'), gluePending('p2', 'ha'), gluePending('p3', 'ha')]

    expect(prunePendingSends(pending, advancedGlueTranscript('haha ha'))).toEqual([])
  })

  it('retires a pending send that is a prefix of the next one', () => {
    const pending = [gluePending('p1', 'hi'), gluePending('p2', 'hi there')]

    expect(prunePendingSends(pending, advancedGlueTranscript('hi hi there'))).toEqual([])
  })

  it('keeps sends when the glue only reaches a prefix of the row', () => {
    const pending = [gluePending('p1', 'hi'), gluePending('p2', 'story')]

    expect(prunePendingSends(pending, advancedGlueTranscript('hi story continued'))).toEqual(
      pending
    )
  })

  it('keeps sends when the row runs out mid-prompt', () => {
    const pending = [gluePending('p1', 'hi'), gluePending('p2', 'there friend')]

    expect(prunePendingSends(pending, advancedGlueTranscript('hi there'))).toEqual(pending)
  })

  // Claude Code v2.1.234 drops a trailing backslash plus CR to continue the same turn; other agents retain it.
  it('still retires literal-backslash sends glued by agents that retain it', () => {
    const pending = [gluePending('p1', 'run\\'), gluePending('p2', 'again')]
    expect(prunePendingSends(pending, advancedGlueTranscript('run\\ again'))).toEqual([])
  })

  it('keeps repeated continuation sends matched to separate transcript occurrences', () => {
    const pending = [gluePending('p1', 'run\\'), gluePending('p2', 'run\\')]
    expect(prunePendingSends(pending, advancedGlueTranscript('run again'))).toEqual([pending[1]])
  })

  it.each(['one\\ two three', 'one two\\ three'])(
    'retires mixed literal and continuation backslashes in %s',
    (text) => {
      const pending = [
        gluePending('p1', 'one\\'),
        gluePending('p2', 'two\\'),
        gluePending('p3', 'three')
      ]
      expect(prunePendingSends(pending, advancedGlueTranscript(text))).toEqual([])
    }
  )

  it('retires a pair whose first send ended in a continuation backslash', () => {
    const pending = [gluePending('p1', 'tell me a joke\\'), gluePending('p2', 'continue')]

    expect(prunePendingSends(pending, advancedGlueTranscript('tell me a joke\ncontinue'))).toEqual(
      []
    )
  })

  it('hides a continuation-backslash pair as soon as its glued row lands', () => {
    const pending = [gluePending('p1', 'tell me a joke\\'), gluePending('p2', 'continue')]

    expect(pendingSendsAsMessages(pending, glueTranscript('tell me a joke\ncontinue'))).toEqual([])
  })

  // Another client or direct terminal input can finish a continuation outside this queue.
  it('retires a lone continuation echo absorbed into a longer turn', () => {
    const pending = [gluePending('p1', 'tell me a joke\\')]

    expect(
      prunePendingSends(pending, advancedGlueTranscript('tell me a joke\nabout cats'))
    ).toEqual([])
  })

  it('keeps a continuation echo when a later row only shares its prefix', () => {
    const pending = [gluePending('p1', 'hi\\')]

    expect(prunePendingSends(pending, advancedGlueTranscript('history repeats'))).toEqual(pending)
  })

  it('retires a continuation echo the user then submitted on its own', () => {
    const pending = [gluePending('p1', 'tell me a joke\\')]

    expect(prunePendingSends(pending, advancedGlueTranscript('tell me a joke'))).toEqual([])
  })

  it('retires a pair when only the last of several backslashes was eaten', () => {
    const pending = [gluePending('p1', 'tell me a joke\\\\'), gluePending('p2', 'continue')]

    expect(
      prunePendingSends(pending, advancedGlueTranscript('tell me a joke\\\ncontinue'))
    ).toEqual([])
  })

  it('retires a run of three sends chained by continuations', () => {
    const pending = [
      gluePending('p1', 'first\\'),
      gluePending('p2', 'second\\'),
      gluePending('p3', 'third')
    ]

    expect(prunePendingSends(pending, advancedGlueTranscript('first\nsecond\nthird'))).toEqual([])
  })

  it('retires the reported prompt, whose text is not Latin', () => {
    const pending = [
      gluePending('p1', '사양을 올리는게 가능해? 이건 과금의 영역아니야?\\'),
      gluePending('p2', '일단 퀵하게 되는 버전으로 반영되어야할거같아')
    ]

    expect(
      prunePendingSends(
        pending,
        advancedGlueTranscript(
          '사양을 올리는게 가능해? 이건 과금의 영역아니야?\n일단 퀵하게 되는 버전으로 반영되어야할거같아'
        )
      )
    ).toEqual([])
  })

  it('keeps a continuation echo the row breaks mid-word', () => {
    // The run must stop on the separator the TUI's newline normalizes to.
    const pending = [gluePending('p1', 'tell me a jo\\')]

    expect(prunePendingSends(pending, advancedGlueTranscript('tell me a joke about cats'))).toEqual(
      pending
    )
  })

  it('keeps a queued pair when an earlier turn splits across it (#14406 regression)', () => {
    const pending = [pendingOf('p1', 'run the tests'), pendingOf('p2', 'again')]

    expect(
      prunePendingSends(pending, [
        userMessage('u1', 'run the tests again'),
        assistantMessage('a1', 'sure')
      ])
    ).toEqual(pending)
  })

  it('keeps a re-sent pair that an older identical turn would match (#14406 regression)', () => {
    const history = [userMessage('u1', 'fix the bug', 1000), assistantMessage('a1', 'fixed', 1100)]
    const pending = [gluePending('p3', 'fix the'), gluePending('p4', 'bug')]

    expect(prunePendingSends(pending, history)).toEqual(pending)
    expect(pendingSendsAsMessages(pending, history)).toHaveLength(2)
  })

  it('keeps a re-sent pair even with no recorded message boundary', () => {
    const history = [userMessage('u1', 'fix the bug', 1000), assistantMessage('a1', 'fixed', 1100)]
    const pending = [
      { id: 'p3', text: 'fix the', sentAt: GLUE_SENT_AT },
      { id: 'p4', text: 'bug', sentAt: GLUE_SENT_AT }
    ]

    expect(prunePendingSends(pending, history)).toEqual(pending)
    expect(pendingSendsAsMessages(pending, history)).toHaveLength(2)
  })

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
  it('returns the empty input without reading existing history', () => {
    const pending: NativeChatPendingSend[] = []
    const unreadableHistory = new Proxy([] as NativeChatMessage[], {
      get: () => {
        throw new Error('existing history was read')
      }
    })

    expect(pendingSendsAsMessages(pending, unreadableHistory)).toEqual([])
  })

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

  it('includes image refs for pending attachment sends', () => {
    const messages = pendingSendsAsMessages([
      { id: 'p1', text: 'what do you see?', imagePaths: ['/tmp/shot.png'], sentAt: 42 }
    ])
    expect(messages[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/shot.png' },
      { type: 'text', text: 'what do you see?' }
    ])
  })

  it('hides an attachment-only pending send while its real image turn is visible', () => {
    const pending = [{ ...pendingOf('p1', ''), imagePaths: ['/tmp/shot.png'] }]

    expect(pendingSendsAsMessages(pending, [imageMessage('u1', '/tmp/shot.png')])).toEqual([])
  })

  it('hides a pending send while its real user turn is visible', () => {
    const pending = [pendingOf('p1', 'first prompt')]

    expect(pendingSendsAsMessages(pending, [userMessage('u1', 'first prompt')])).toEqual([])
    expect(pendingSendsAsMessages(pending, [])).toHaveLength(1)
  })

  it('keeps a repeated prompt visible when its only match predates the send boundary', () => {
    const history = [userMessage('old-user', 'run tests'), assistantMessage('old-answer', 'passed')]
    const pending = [{ ...pendingOf('new-send', 'run tests'), afterMessageId: 'old-answer' }]

    expect(pendingSendsAsMessages(pending, history).map((message) => message.id)).toEqual([
      'pending:new-send'
    ])
  })

  it('keeps a loading-time send visible when older matching history arrives later', () => {
    const history = [
      { ...userMessage('old-user', 'run tests'), timestamp: 10 },
      { ...assistantMessage('old-answer', 'passed'), timestamp: 20 }
    ]
    const pending = [{ ...pendingOf('new-send', 'run tests'), sentAt: 100, afterMessageId: null }]

    expect(pendingSendsAsMessages(pending, history).map((message) => message.id)).toEqual([
      'pending:new-send'
    ])
    expect(prunePendingSends(pending, history)).toEqual(pending)
  })

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

  it('hides a first send while its timestampless transcript turn is visible (grok)', () => {
    const pending = [{ ...pendingOf('p1', 'rename it'), afterMessageId: null }]

    expect(
      pendingSendsAsMessages(pending, [{ ...userMessage('u1', 'rename it'), timestamp: null }])
    ).toEqual([])
  })

  it('hides only one of two identical pending sends for one real user turn', () => {
    const pending = [pendingOf('p1', 'repeat'), pendingOf('p2', 'repeat')]
    expect(pendingSendsAsMessages(pending, [userMessage('u1', 'repeat')]).map((m) => m.id)).toEqual(
      ['pending:p2']
    )
  })
})

describe('isPendingMessageId', () => {
  it('recognizes the pending id prefix', () => {
    expect(isPendingMessageId('pending:p1')).toBe(true)
    expect(isPendingMessageId('transcript-123')).toBe(false)
  })
})
