import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../native-chat-types'
import {
  readAgentMessageSource,
  type AgentMessageSource
} from '../../agent-session/agent-session-message-source'
import { nativeChatAskDismissKey } from '../../native-chat-ask-dismiss-key'
import {
  extractPendingAsk,
  extractPendingMessageReplyAsk,
  aggregateAsyncQuestions,
  asyncQuestionOccurrenceId,
  asyncQuestionSourceScope,
  scanPendingAsks,
  createPendingAskScanner,
  isDeliveredNativeChatUserMessage,
  resolveNativeChatAsk
} from './native-chat-ask'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

function call(name: string, input: unknown): NativeChatBlock {
  return { type: 'tool-call', name, input }
}

function result(): NativeChatBlock {
  return { type: 'tool-result', output: 'ok' }
}

/** The row the transcript decoders emit for an interrupted turn. */
function interrupted(id: string): NativeChatMessage {
  return {
    id,
    role: 'system',
    blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
    timestamp: 1,
    source: 'transcript'
  }
}

function userTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

/** Claude delivers tool results on their own turn, which decodes as role 'tool'. */
function toolTurn(id: string): NativeChatMessage {
  return { id, role: 'tool', blocks: [result()], timestamp: 1, source: 'transcript' }
}

const QUESTIONS_INPUT = {
  questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }]
}

describe('extractPendingAsk', () => {
  it('recognizes an unregistered tool whose input matches the canonical questions shape', () => {
    // Match live status’s arbitrary-tool canonical-shape fallback during transcript replay.
    const pending = extractPendingAsk([message('m1', [call('CustomAskTool', QUESTIONS_INPUT)])])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('resolves calls FIFO so a sibling result cannot clear a newer pending ask', () => {
    const pending = extractPendingAsk([
      message('m1', [
        call('Bash', { command: 'ls' }),
        call('AskUserQuestion', QUESTIONS_INPUT),
        // FIFO: this result answers the Bash call, not the ask.
        result()
      ])
    ])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('keeps the newest ask when an older call receives its result', () => {
    const first = { questions: [{ question: 'First?', options: [] }] }
    const pending = extractPendingAsk([
      message('m1', [
        call('AskUserQuestion', first),
        call('AskUserQuestion', QUESTIONS_INPUT),
        // Resolves the FIRST ask (FIFO); the newer one stays pending.
        result()
      ])
    ])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('does not strand an answered ask behind a tool call orphaned by an interrupt', () => {
    // Claude interrupts omit tool results, leaving orphan FIFO slots (#11761).
    const pending = extractPendingAsk([
      message('m1', [call('Bash', { command: 'sleep 999' })]),
      interrupted('m2'),
      message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      message('m4', [result()])
    ])
    expect(pending).toBeNull()
  })

  it('drops an ask abandoned by an interrupt', () => {
    const pending = extractPendingAsk([
      message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      interrupted('m2')
    ])
    expect(pending).toBeNull()
  })

  it('drops an ask the user typed past instead of answering', () => {
    // Escaping a selector and sending a prompt can leave the ask without a result.
    const pending = extractPendingAsk([
      message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      userTurn('m2', 'never mind, do this instead'),
      message('m3', [{ type: 'text', text: 'on it' }])
    ])
    expect(pending).toBeNull()
  })

  it('does not strand an answered ask behind an orphan left by a plain-text interrupt', () => {
    // Claude can record interrupts as bare user turns without interruptedMessageId/status rows.
    const pending = extractPendingAsk([
      message('m1', [call('Bash', { command: 'sleep 999' })]),
      userTurn('m2', '[Request interrupted by user]'),
      message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      toolTurn('m4')
    ])
    expect(pending).toBeNull()
  })
})

describe('resolveNativeChatAsk', () => {
  const transcript = [message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)])]

  it('withholds transcript state until the read settles', () => {
    expect(
      resolveNativeChatAsk({ liveAsk: null, messages: transcript, transcriptSettled: false })
    ).toBeNull()
    expect(
      resolveNativeChatAsk({ liveAsk: null, messages: transcript, transcriptSettled: true })
    )?.toMatchObject(QUESTIONS_INPUT)
  })
})

describe('async questions', () => {
  const asyncCall = (callId: string, title: string): NativeChatBlock => ({
    type: 'tool-call',
    name: 'request_user_input_async',
    callId,
    input: JSON.stringify({ questions: [{ title, options: ['Yes', 'No'] }] })
  })
  const userRow = (id: string, flags: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
    ...message(id, [{ type: 'text', text: 'hi' }]),
    role: 'user',
    ...flags
  })
  it('addresses accepted calls independently of definition, provider IDs and unrelated blocks', () => {
    const first = message('a', [
      call('request_user_input_async', { questions: [{ title: 'A?' }, { title: 'B?' }] }),
      asyncCall('call-c', 'C?'),
      result()
    ])
    const scan = scanPendingAsks([first, message('b', [asyncCall('call-c', 'duplicate')])])
    expect(scan.contributors).toMatchObject([
      {
        sourceRowId: 'a',
        callSlot: 0,
        timestamp: 1,
        responseMode: 'message',
        questions: [{ question: 'A?' }, { question: 'B?' }]
      },
      { sourceRowId: 'a', callSlot: 1, questions: [{ question: 'C?' }] }
    ])
    expect(scan.contributors).toHaveLength(2)
    const pending = aggregateAsyncQuestions(scan.contributors, 'host/session/epoch')!
    const ids = pending.occurrenceIds!
    expect(new Set(ids).size).toBe(2)
    expect(
      aggregateAsyncQuestions(
        scan.contributors,
        'host/session/epoch',
        new Set([ids[0]!])
      )?.questions.map((q) => q.question)
    ).toEqual(['C?'])
    expect(
      aggregateAsyncQuestions(
        scan.contributors,
        'host/session/epoch',
        new Set([ids[1]!])
      )?.questions.map((q) => q.question)
    ).toEqual(['A?', 'B?'])
    const replay = scanPendingAsks([
      {
        ...first,
        timestamp: null,
        blocks: [
          { type: 'text', text: 'prefix' },
          call('Bash', {}),
          call('request_user_input_async', { questions: [{ title: 'Edited?' }] }),
          asyncCall('renumbered', 'C?')
        ]
      }
    ])
    expect(replay.contributors[0]?.timestamp).toBeNull()
    expect(
      aggregateAsyncQuestions(replay.contributors, 'host/session/epoch')?.occurrenceIds
    ).toEqual(ids)
    expect(
      aggregateAsyncQuestions(replay.contributors, 'host/session/epoch', new Set(ids))
    ).toBeNull()
    for (const scope of [
      'other-host/session/epoch',
      'host/other-session/epoch',
      'host/session/reset'
    ]) {
      expect(asyncQuestionOccurrenceId(scope, scan.contributors[0]!)).not.toBe(ids[0])
    }
    const later = scanPendingAsks([message('later', [asyncCall('renumbered', 'A?')])])
    expect(asyncQuestionOccurrenceId('host/session/epoch', later.contributors[0]!)).not.toBe(ids[0])
    const repeated = scanPendingAsks([
      message('a', [call('request_user_input_async', { questions: [{ title: 'A?' }] })]),
      message('a', [call('request_user_input_async', { questions: [{ title: 'A?' }] })])
    ])
    expect(repeated.contributors.map((c) => c.callSlot)).toEqual([0, 1])
  })

  it('shares portable descriptor spelling while distinguishing source/session/reset/path', () => {
    const contributor = scanPendingAsks([message('same-row', [asyncCall('A', 'QA')])])
      .contributors[0]!
    const journal = {
      kind: 'journal' as const,
      agent: 'codex',
      sessionId: 'session',
      epoch: 'epoch'
    }
    const id = (source: Parameters<typeof asyncQuestionSourceScope>[0]) =>
      asyncQuestionOccurrenceId(asyncQuestionSourceScope(source), contributor)
    expect(id({ ...journal })).toBe(id(journal))
    expect(asyncQuestionSourceScope(journal)).toBe(
      JSON.stringify(['journal', 'codex', 'session', 'epoch'])
    )
    for (const source of [
      { ...journal, agent: 'claude' },
      { ...journal, sessionId: 'another' },
      { ...journal, epoch: 'reset' },
      { kind: 'transcript' as const, agent: 'codex', sessionId: 'session', transcriptPath: null },
      {
        kind: 'transcript' as const,
        agent: 'codex',
        sessionId: 'session',
        transcriptPath: '/explicit/path'
      }
    ]) {
      expect(id(source)).not.toBe(id(journal))
    }
    const terminal = {
      kind: 'transcript' as const,
      agent: 'codex',
      sessionId: 'session',
      transcriptPath: null
    }
    expect(id(terminal)).not.toBe(id({ ...terminal, transcriptPath: '/explicit/path' }))
  })

  it('keeps a surviving sibling addressed when a deduping prefix leaves the loaded window', () => {
    const prefix = message('P', [asyncCall('A', 'QA')])
    const row = message('R', [asyncCall('A', 'QA'), asyncCall('B', 'QB')])
    const before = aggregateAsyncQuestions(scanPendingAsks([prefix, row]).contributors, 'source')!
    const hidden = new Set([before.occurrenceIds![1]!])
    const after = aggregateAsyncQuestions(scanPendingAsks([row]).contributors, 'source', hidden)!
    expect(after.questions.map((q) => q.question)).toEqual(['QA'])
    expect(after.occurrenceIds).not.toContain(before.occurrenceIds![1])
  })

  it('exposes exactly the existing chronological interrupt without consuming call slots', () => {
    const prefix = message('R1', [
      call('Bash', {}),
      asyncCall('X', 'Q1'),
      call('AskUserQuestion', QUESTIONS_INPUT)
    ])
    const suffix = [
      message('R2', [asyncCall('X', 'Q2'), result()]),
      message('R1', [asyncCall('Y', 'Q3'), result()]),
      message('blocking', [call('AskUserQuestion', QUESTIONS_INPUT), result()])
    ]
    const direct = createPendingAskScanner()
    const emitted = direct.append(prefix)
    const borrowed = direct.current().contributors
    expect(direct.current().blocking).not.toBeNull()
    direct.interrupt()
    direct.interrupt()
    expect(direct.current()).toEqual({ blocking: null, contributors: [] })
    for (const row of suffix) {
      direct.append(row)
    }
    const fromRow = scanPendingAsks([prefix, interrupted('boundary'), ...suffix])
    expect(direct.current()).toEqual(fromRow)
    expect(fromRow.blocking).toBeNull()
    expect(fromRow.contributors.map((c) => [c.sourceRowId, c.callSlot])).toEqual([
      ['R2', 0],
      ['R1', 1]
    ])
    expect(emitted).toEqual(borrowed)
    expect(emitted.map((c) => c.questions[0]?.question)).toEqual(['Q1'])
  })

  it('folds once and reports accepted calls even when a later delivery retires them', () => {
    const scanner = createPendingAskScanner()
    const first = scanner.append(message('a', [asyncCall('A', 'QA')]))
    const borrowed = scanner.current().contributors
    expect(first).toHaveLength(1)
    expect(scanner.append(message('noise', [{ type: 'text', text: 'working' }]))).toEqual([])
    expect(scanner.current().contributors).toBe(borrowed)
    expect(isDeliveredNativeChatUserMessage(userRow('queued', { queued: true }))).toBe(false)
    expect(isDeliveredNativeChatUserMessage(message('assistant', []))).toBe(false)
    expect(isDeliveredNativeChatUserMessage(userRow('delivered'))).toBe(true)
    scanner.append(userRow('delivered'))
    expect(scanner.current().contributors).toEqual([])
    expect(first[0]?.questions[0]?.question).toBe('QA')
    expect(scanner.append(message('b', [asyncCall('A', 'QA')]))).toHaveLength(1)
  })

  it('keeps notice replay and dedupe separate from the blocking and human boundaries', () => {
    const scanner = createPendingAskScanner()
    scanner.append(
      message('asked', [asyncCall('same-call', 'A?'), call('AskUserQuestion', QUESTIONS_INPUT)])
    )
    const pending = scanner.current().contributors
    expect(scanner.current().blocking).not.toBeNull()
    const notice = userRow('notice', {
      from: { kind: 'agent', senders: [], orchestration: null },
      blocks: [{ type: 'text', text: 'Blue' }]
    })
    expect(isDeliveredNativeChatUserMessage(notice)).toBe(false)
    scanner.append(notice)
    expect(scanner.current().contributors).toBe(pending)
    expect(scanner.current().blocking).toBeNull()
    expect(scanner.append(message('replay', [asyncCall('same-call', 'duplicate')]))).toEqual([])
    scanner.append({ ...notice, id: 'legacy-human', from: undefined })
    expect(scanner.current().contributors).toEqual([])
    expect(scanner.append(message('new', [asyncCall('same-call', 'new question')]))).toHaveLength(1)
    expect(
      scanPendingAsks([message('asked', [asyncCall('same-call', 'A?')]), notice]).contributors
    ).toEqual(pending)
  })

  it.each(['queued', 'unsent', 'stoppedBeforeStart', 'awaitsRetry', 'sentWhileStopping'] as const)(
    'stays open while a human row is marked %s',
    (flag) => {
      const asked = message('a', [asyncCall('call-a', 'A?'), result()])
      const waiting = userRow('waiting', { [flag]: true })
      expect(extractPendingAsk([asked, waiting])?.questions.map((q) => q.question)).toEqual(['A?'])
      const scanner = createPendingAskScanner()
      scanner.append(asked)
      const pending = scanner.current().contributors
      scanner.append(waiting)
      expect(scanner.current().contributors).toBe(pending)
      expect(isDeliveredNativeChatUserMessage(waiting)).toBe(false)
      expect(extractPendingAsk([asked, userRow('sent')])).toBeNull()
    }
  )

  it('keeps async controls across agent notices and replay until human input or interruption', () => {
    const asked = message('a', [asyncCall('call-a', 'A?'), result()])
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Coder'
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'term_b',
        dispatchId: null,
        messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'term_a' }]
      }
    }
    for (const source of [
      from,
      { ...from, orchestration: null },
      { ...from, senders: [], orchestration: { message: 'future-notice' } }
    ]) {
      const notice = userRow('notice', {
        from: readAgentMessageSource(source),
        blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }]
      })
      expect(notice.from?.kind).toBe('agent')
      const history = [asked, notice]
      for (const extract of [extractPendingAsk, extractPendingMessageReplyAsk]) {
        const expected = extract([asked])
        expect(expected?.questions[0]?.options).toEqual([{ label: 'Yes' }, { label: 'No' }])
        expect(extract(history)).toEqual(expected)
        expect(extract([...history])).toEqual(expected)
        expect(extract([...history, userRow('human-answer')])).toBeNull()
        expect(extract([...history, interrupted('stop')])).toBeNull()
      }
    }
  })

  it('bounds real scan, hide filtering and form serialization at N/10N without replay accumulation', () => {
    function measure(callCount: number, titleLength = 32) {
      let blockReads = 0
      const rows = Array.from({ length: callCount }, (_, index) => {
        const id = String(index).padStart(4, '0')
        return message(`row-${id}`, [
          {
            get type() {
              blockReads += 1
              return 'tool-call' as const
            },
            name: 'request_user_input_async',
            callId: `call-${id}`,
            input: { questions: [{ title: 'é'.repeat(titleLength) }] }
          }
        ])
      })
      const stringify = JSON.stringify
      function read(messages: NativeChatMessage[], hideAll = false) {
        blockReads = 0
        let serializedBytes = 0
        let serializations = 0
        // Observe real serialization, including any intermediate occurrence strings.
        const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
          const encoded = stringify(value)
          serializedBytes += new TextEncoder().encode(encoded).byteLength
          serializations += 1
          return encoded
        })
        try {
          let filterChecks = 0
          const hidden = new Set<string>()
          hidden.has = () => {
            filterChecks += 1
            return hideAll
          }
          const scan = scanPendingAsks(messages)
          const key = nativeChatAskDismissKey(
            aggregateAsyncQuestions(scan.contributors, 'source/session/epoch', hidden)
          )
          return { key, blockReads, filterChecks, serializedBytes, serializations }
        } finally {
          spy.mockRestore()
        }
      }

      const first = read(rows)
      expect(first.key).not.toBeNull()
      expect(first.blockReads).toBeGreaterThanOrEqual(callCount)
      expect(first.blockReads).toBeLessThanOrEqual(2 * callCount)
      expect(first.filterChecks).toBe(callCount)
      expect(first.serializations).toBeLessThanOrEqual(callCount + 1)
      expect(first.serializedBytes).toBeGreaterThan(callCount * titleLength * 2)
      expect(first.serializedBytes).toBeLessThanOrEqual(callCount * (768 + 4 * titleLength))
      for (let readback = 0; readback < 3; readback += 1) {
        expect(read(rows.map((row) => ({ ...row, blocks: [...row.blocks] })))).toEqual(first)
      }

      const noAsync = rows.map((row) =>
        message(
          row.id,
          row.blocks.map(() => ({
            get type() {
              blockReads += 1
              return 'tool-call' as const
            },
            name: 'Bash',
            input: {}
          }))
        )
      )
      expect(read(noAsync)).toEqual({
        key: null,
        blockReads: first.blockReads,
        filterChecks: 0,
        serializedBytes: 0,
        serializations: 0
      })
      expect(read([...rows, userRow('delivered')])).toMatchObject({
        key: null,
        blockReads: first.blockReads,
        filterChecks: 0,
        serializedBytes: 0,
        serializations: 0
      })
      expect(read(rows, true)).toMatchObject({
        key: null,
        filterChecks: callCount,
        serializations: callCount
      })
      const replacement = message('new-0000', [asyncCall('call-0000', 'é'.repeat(titleLength))])
      const replaced = read([...rows, userRow('delivered'), replacement])
      expect(replaced.key).not.toBe(first.key)
      expect(replaced.serializedBytes).toBe(read([replacement]).serializedBytes)
      return first
    }

    const small = measure(24)
    const large = measure(240)
    expect(large.blockReads).toBeLessThanOrEqual(10 * small.blockReads)
    expect(large.serializedBytes).toBeLessThanOrEqual(10 * small.serializedBytes + 16)
    // Grow text independently of call count: the bound includes full UTF-8 question content.
    const longQuestions = measure(24, 320)
    expect(longQuestions.serializedBytes).toBeGreaterThan(2 * small.serializedBytes)
    expect(longQuestions.serializedBytes).toBeLessThanOrEqual(10 * small.serializedBytes + 16)
  })
})
