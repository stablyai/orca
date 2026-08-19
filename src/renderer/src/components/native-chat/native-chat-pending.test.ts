import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendPendingSendCache,
  clearPendingSendCacheForTests,
  isLaunchPromptMessageId,
  isPendingMessageId,
  launchPromptAsMessage,
  nextNativeChatPendingSendId,
  pendingSendsAsMessages,
  prunePendingSends,
  readPendingSendCache,
  shouldPruneLaunchPrompt,
  writePendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import {
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  clearCommandMarkerCacheForTests,
  commandMarkersAsMessages,
  isCommandMarkerId,
  readCommandMarkerCache
} from './native-chat-command-marker'
import { stripNoiseMessages } from './native-chat-noise'

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

// A glued row is written by the agent AFTER the sends that produced it, so every
// fixture here puts the transcript row past `sentAt`. Matching an earlier row is
// the failure mode these tests exist to pin down.
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

/** Visible history, the send boundary, then the row the agent glued the queue into. */
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

  it('keeps a queued pair when an earlier turn splits across it (#14406 regression)', () => {
    // The row predates both sends: "run the tests"+"again" only looks glued.
    const pending = [pendingOf('p1', 'run the tests'), pendingOf('p2', 'again')]

    expect(
      prunePendingSends(pending, [
        userMessage('u1', 'run the tests again'),
        assistantMessage('a1', 'sure')
      ])
    ).toEqual(pending)
  })

  it('keeps a re-sent pair that an older identical turn would match (#14406 regression)', () => {
    // Rapid-sending "fix the"+"bug" a second time must not bind to the first
    // "fix the bug" turn — that drops a real queued prompt with no bubble.
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

  // A row that already existed when a send was issued can never be that send's
  // echo — for EVERY queued send, not just the oldest one the glue run starts at.
  const mixedAgeGlue = (): { messages: NativeChatMessage[]; pending: NativeChatPendingSend[] } => {
    const gluedRow = userMessage('glue-row', 'fix the bug', 6000)
    return {
      messages: [
        GLUE_BOUNDARY,
        gluedRow,
        assistantMessage('glue-answer', 'fixed', 6100),
        userMessage('later-history', 'anything', 6200)
      ],
      // 'fix the' was queued before the row landed; 'bug' only after it.
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

  // Separate from the prune case on purpose: the render path is what makes the
  // bubble visually vanish, and a shared `it` would mask it behind the first
  // failing assertion.
  it('still renders a queued send whose own boundary is newer than the row (STA-4477)', () => {
    const { messages, pending } = mixedAgeGlue()

    expect(pendingSendsAsMessages(pending, messages)).toHaveLength(2)
  })

  // Glue is adjacency: a send the row predates ends the run rather than being
  // skipped, so a row must never bridge across a send it cannot represent.
  it('never glues across a send the row cannot represent (STA-4477)', () => {
    const gluedRow = userMessage('glue-row', 'alpha gamma', 6000)
    const messages = [GLUE_BOUNDARY, gluedRow, assistantMessage('glue-answer', 'ok', 6100)]
    const pending = [
      gluePending('p1', 'alpha'),
      // Queued after the row landed, so the row is not its echo...
      {
        id: 'p2',
        text: 'beta',
        sentAt: 7000,
        afterMessageId: 'glue-row',
        afterMessageTimestamp: 6000
      },
      // ...and 'alpha'+'gamma' must not close over the gap it leaves.
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

describe('launchPromptAsMessage', () => {
  it('maps a launch prompt to a tab-keyed scrape-source user message', () => {
    expect(
      launchPromptAsMessage({
        tabId: 'tab-1',
        agent: 'codex',
        text: 'Fix failing checks',
        createdAt: 42
      })
    ).toEqual({
      id: 'launch-pending:tab-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix failing checks' }],
      timestamp: 42,
      source: 'scrape'
    })
  })

  it('hides the launch prompt while its transcript user turn is visible', () => {
    expect(
      launchPromptAsMessage(
        {
          tabId: 'tab-1',
          agent: 'codex',
          text: 'Fix failing checks',
          createdAt: 42
        },
        [{ ...userMessage('u1', 'Fix failing checks'), timestamp: 43 }]
      )
    ).toBeNull()
  })

  it('uses pending-send normalization for large multiline generated prompts', () => {
    const prompt = [
      '[Image #1] Resolve the failing checks:',
      '',
      'Resolve the failing checks:',
      '',
      '- lint failed',
      '  fix spacing'
    ].join('\n')
    const transcript = [
      {
        ...userMessage(
          'u1',
          'Resolve the failing checks: Resolve the failing checks: - lint failed fix spacing'
        ),
        timestamp: 43
      },
      { ...assistantMessage('a1', 'I will fix it'), timestamp: 44 }
    ]

    expect(
      shouldPruneLaunchPrompt(
        {
          tabId: 'tab-1',
          agent: 'codex',
          text: prompt,
          createdAt: 42
        },
        transcript
      )
    ).toBe(true)
  })

  it('keeps the launch prompt until the transcript advances past the user turn', () => {
    const prompt = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'Fix failing checks',
      createdAt: 42
    }

    expect(
      shouldPruneLaunchPrompt(prompt, [
        { ...userMessage('u1', 'Fix failing checks'), timestamp: 43 }
      ])
    ).toBe(false)
    expect(
      shouldPruneLaunchPrompt(prompt, [
        { ...userMessage('u1', 'Fix failing checks'), timestamp: 43 },
        { ...assistantMessage('a1', 'working'), timestamp: 44 }
      ])
    ).toBe(true)
  })

  // Grok transcripts carry no timestamps; before the null-matchable rule the
  // seeded bubble was never hidden or pruned and sat rank-pinned at the list
  // tail forever, reading as the conversation reordering.
  it('hides and prunes the launch prompt against a timestampless transcript (grok)', () => {
    const entry = { tabId: 'tab-1', agent: 'grok' as const, text: 'rename it', createdAt: 42 }
    const transcript = [
      { ...userMessage('u1', 'rename it'), timestamp: null },
      { ...assistantMessage('a1', 'done'), timestamp: null }
    ]

    expect(launchPromptAsMessage(entry, transcript)).toBeNull()
    expect(shouldPruneLaunchPrompt(entry, transcript)).toBe(true)
  })

  it('does not bind a launch prompt to an older identical completed turn', () => {
    const entry = {
      tabId: 'tab-1',
      agent: 'claude' as const,
      text: 'run tests',
      createdAt: 100
    }
    const oldHistory = [
      { ...userMessage('old-user', 'run tests'), timestamp: 10 },
      { ...assistantMessage('old-answer', 'passed'), timestamp: 20 }
    ]

    expect(launchPromptAsMessage(entry, oldHistory)).not.toBeNull()
    expect(shouldPruneLaunchPrompt(entry, oldHistory)).toBe(false)
  })
})

describe('pending send cache', () => {
  it('persists optimistic sends for the same pane and agent', () => {
    clearPendingSendCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex' }

    const appended = appendPendingSendCache(scope, pendingOf('p1', 'first prompt'))

    expect(appended).toEqual([pendingOf('p1', 'first prompt')])
    expect(readPendingSendCache(scope)).toEqual(appended)
    expect(readPendingSendCache({ ...scope, agent: 'claude' })).toEqual([])
  })

  it('mints unique ids across chat-view remounts while the cache survives', () => {
    clearPendingSendCacheForTests()
    const first = nextNativeChatPendingSendId(100)
    const second = nextNativeChatPendingSendId(100)
    expect(second).not.toBe(first)
  })

  it('clears cached pending sends when pruning removes all entries', () => {
    clearPendingSendCacheForTests()
    const scope = { paneKey: 'tab-a:leaf-a', agent: 'codex' }
    appendPendingSendCache(scope, pendingOf('p1', 'first prompt'))

    writePendingSendCache(scope, [])

    expect(readPendingSendCache(scope)).toEqual([])
  })
})

describe('isPendingMessageId', () => {
  it('recognizes the pending id prefix', () => {
    expect(isPendingMessageId('pending:p1')).toBe(true)
    expect(isPendingMessageId('transcript-123')).toBe(false)
  })
})

describe('isLaunchPromptMessageId', () => {
  it('recognizes the launch prompt id prefix', () => {
    expect(isLaunchPromptMessageId('launch-pending:tab-1')).toBe(true)
    expect(isLaunchPromptMessageId('pending:p1')).toBe(false)
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

describe('scope-cache key counts stay bounded (memory-leak regression)', () => {
  // The per-key arrays were capped at 8, but the KEY count (paneKey/agent/session,
  // all ephemeral) was unbounded, so distinct panes/sessions accumulated forever.
  // Both caches now LRU-bound the key count at 128 (shared helper, #7566).
  const CAP = 128

  it('appendCommandMarkerCache evicts the oldest scope key past the cap', () => {
    clearCommandMarkerCacheForTests()
    for (let i = 0; i < CAP + 5; i++) {
      appendCommandMarkerCache(
        { paneKey: 'tab:leaf', agent: 'claude', sessionId: `s${i}` },
        '/clear'
      )
    }
    // Oldest sessions evicted; the most-recent CAP survive.
    expect(
      readCommandMarkerCache({ paneKey: 'tab:leaf', agent: 'claude', sessionId: 's0' })
    ).toEqual([])
    expect(
      readCommandMarkerCache({ paneKey: 'tab:leaf', agent: 'claude', sessionId: 's4' })
    ).toEqual([])
    expect(
      readCommandMarkerCache({ paneKey: 'tab:leaf', agent: 'claude', sessionId: `s${CAP + 4}` })
    ).toHaveLength(1)
  })

  it('writePendingSendCache evicts the oldest scope key past the cap', () => {
    clearPendingSendCacheForTests()
    const send = (id: string): NativeChatPendingSend => ({ id, text: id, sentAt: 1 })
    for (let i = 0; i < CAP + 5; i++) {
      writePendingSendCache({ paneKey: `tab-${i}:leaf`, agent: 'claude' }, [send(`m${i}`)])
    }
    expect(readPendingSendCache({ paneKey: 'tab-0:leaf', agent: 'claude' })).toEqual([])
    expect(readPendingSendCache({ paneKey: `tab-${CAP + 4}:leaf`, agent: 'claude' })).toHaveLength(
      1
    )
  })
})
