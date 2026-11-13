import { describe, expect, it } from 'vitest'
import {
  formatAskAnswer,
  isPendingNativeChatUserMessage,
  nativeChatAnswerOperationPending
} from './native-chat-ask-answer'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../agent-session/requests/structured-agent-session-send-evidence'
import { projectStructuredAgentSessionMessages } from '../../agent-session/view/structured-agent-session-message-projection'
import type { StructuredAgentSessionOptimisticMessage } from '../../agent-session/view/structured-agent-session-message-projection'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../native-chat-types'
import {
  extractPendingAsk,
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
  it('sends the selected question identity when titles repeat', () => {
    const pending = extractPendingAsk([
      message('a', [asyncCall('first', 'Same?')]),
      message('b', [asyncCall('second', 'Same?')])
    ])!
    expect(formatAskAnswer(pending, [{ indices: [] }, { indices: [1] }])).toBe(
      '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"second\\",0]","question":"Same?","answer":"No"}]</send_user_message_question_reply>'
    )
    const answered = userTurn(
      'answer',
      '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"second\\",0]","answer":"No"}]</send_user_message_question_reply>'
    )
    expect(
      scanPendingAsks([
        message('a', [asyncCall('first', 'Same?')]),
        message('b', [asyncCall('second', 'Same?')]),
        answered,
        message('replay', [asyncCall('second', 'Same?')])
      ]).contributors.map((entry) => entry.sourceRowId)
    ).toEqual(['a'])
  })

  it('holds only the addressed part of a queued answer, preserving unanswered siblings', () => {
    const asked = message('a', [
      call('request_user_input_async', {
        questions: [{ title: 'Database?' }, { title: 'Region?' }]
      })
    ])
    const text = '> Database?\n\nPostgres'
    const contributors = scanPendingAsks([asked]).contributors
    expect(aggregateAsyncQuestions(contributors, undefined, undefined, [text])?.questions).toEqual([
      { question: 'Region?', multiSelect: false, options: [] }
    ])
    expect(
      scanPendingAsks([
        asked,
        {
          ...userTurn('queued-answer', text),
          queuedMessageId: 'queued',
          deliveryState: 'pending'
        }
      ]).contributors.flatMap((entry) => entry.questions.map((question) => question.question))
    ).toEqual(['Region?'])
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
    expect(scanner.current().blocking).not.toBeNull()
    expect(scanner.append(message('replay', [asyncCall('same-call', 'duplicate')]))).toEqual([])
    scanner.append({ ...notice, id: 'legacy-human', from: undefined })
    expect(scanner.current().contributors).toEqual(pending)
    scanner.append(interrupted('cancel'))
    expect(scanner.current().contributors).toEqual([])
    expect(scanner.append(message('new', [asyncCall('same-call', 'new question')]))).toHaveLength(1)
    expect(
      scanPendingAsks([message('asked', [asyncCall('same-call', 'A?')]), notice]).contributors
    ).toEqual(pending)
  })

  it('uses write index when a held answer and a newer question share a journal sequence', () => {
    const first = {
      ...message('first', [asyncCall('first', 'A?')]),
      journalPosition: { sequence: 1, index: 0 }
    }
    const later = {
      ...message('later', [asyncCall('later', 'A?')]),
      journalPosition: { sequence: 2, index: 1 }
    }
    const held = userRow('answer', {
      deliveryState: 'pending',
      queuedMessageId: 'queue',
      journalPosition: { sequence: 2, index: 0 },
      blocks: [{ type: 'text', text: '> A?\n\nYes' }]
    })
    const result = scanPendingAsks([first, later, held])
    expect(result.contributors.map((row) => row.sourceRowId)).toEqual(['later'])
    expect(result.answerPending).toBeUndefined()
  })

  it('leaves questions available for unacknowledged composer previews, including revised existing rows', () => {
    const first = {
      ...message('first', [asyncCall('first', 'A?')]),
      journalPosition: { sequence: 1, index: 0 }
    }
    const revised = {
      ...message('revised', [asyncCall('revised', 'A?')]),
      journalPosition: { sequence: 2, index: 0 }
    }
    const preview = userRow('preview', {
      deliveryState: 'unknown',
      queuedMessageId: 'queue',
      blocks: [{ type: 'text', text: '> A?\n\nYes' }]
    })
    const scan = scanPendingAsks([first, revised, preview])
    expect(scan.contributors.map((row) => row.sourceRowId)).toEqual(['first', 'revised'])
    expect(scan.answerPending).toBeUndefined()
    expect(
      scanPendingAsks([
        first,
        revised,
        { ...preview, deliveryState: 'pending', journalPosition: { sequence: 3, index: 0 } }
      ]).contributors
    ).toEqual([])
  })
})

it('separates real operation and host evidence from echo placement', () => {
  const echo: StructuredAgentSessionOptimisticMessage = {
    clientMessageId: 'answer',
    queuedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [] }
  }
  const operation = { clientMessageId: 'answer', inFlight: true }
  const project = (entry = echo) => projectStructuredAgentSessionMessages([], [entry], [])
  const positioned = { ...echo, afterSequence: 2 }
  for (const entry of [echo, positioned]) {
    const rows = project(entry)
    expect(rows[0]?.deliveryState).toBe('unknown')
    expect(nativeChatAnswerOperationPending(operation, rows)).toBe(true)
    expect(nativeChatAnswerOperationPending({ ...operation, inFlight: false }, rows)).toBe(false)
    expect(isDeliveredNativeChatUserMessage(rows[0]!)).toBe(false)
  }
  const missing = {
    clientMessageId: 'answer',
    fence: 1,
    payloadFingerprint: 'answer',
    dispatchState: 'unknown',
    reason: STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING,
    providerItemId: null,
    submittedAt: 1,
    resolvedAt: null
  } as const
  const rows = projectStructuredAgentSessionMessages([], [positioned], [missing])
  expect(rows[0]?.deliveryState).toBe('unknown')
  expect(nativeChatAnswerOperationPending(operation, rows, [missing])).toBe(true)
  const pending = { ...missing, dispatchState: 'pending', reason: null } as const
  expect(nativeChatAnswerOperationPending({ ...operation, inFlight: false }, [], [pending])).toBe(
    true
  )
  const acknowledged = projectStructuredAgentSessionMessages(
    [],
    [{ ...echo, phase: 'recorded' }],
    [missing]
  )
  expect(acknowledged[0]?.deliveryState).toBe('pending')
  expect(isPendingNativeChatUserMessage(acknowledged[0]!)).toBe(true)
  expect(
    nativeChatAnswerOperationPending({ ...operation, inFlight: false }, acknowledged, [missing])
  ).toBe(true)
  expect(
    nativeChatAnswerOperationPending(operation, acknowledged, [
      { ...pending, dispatchState: 'unknown' }
    ])
  ).toBe(false)
})
