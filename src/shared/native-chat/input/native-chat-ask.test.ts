import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../native-chat-types'
import { extractPendingAsk, resolveNativeChatAsk } from './native-chat-ask'

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
    input: JSON.stringify({ questions: [{ title }] })
  })
  const userRow = (id: string, flags: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
    ...message(id, [{ type: 'text', text: 'hi' }]),
    role: 'user',
    ...flags
  })
  const titles = (messages: NativeChatMessage[]): string[] | undefined =>
    extractPendingAsk(messages)?.questions.map((question) => question.question)

  it('keeps every unanswered async question, once per call', () => {
    const first = message('a', [asyncCall('call-a', 'A?'), result()])
    expect(titles([first, first, message('b', [asyncCall('call-b', 'B?'), result()])])).toEqual([
      'A?',
      'B?'
    ])
  })

  it('stays open until a user message reaches the agent', () => {
    const asked = message('a', [asyncCall('call-a', 'A?'), result()])
    expect(titles([asked, userRow('q', { queued: true }), userRow('u', { unsent: true })])).toEqual(
      ['A?']
    )
    expect(extractPendingAsk([asked, userRow('sent')])).toBeNull()
  })
})
