import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from './native-chat-types'
import {
  extractPendingAsk,
  nativeChatAskDismissKey,
  parseAskFromStatus,
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

describe('nativeChatAskDismissKey', () => {
  it('uses the full canonical prompt and stays stable across object instances', () => {
    const first = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))
    const same = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))
    const changed = parseAskFromStatus(
      JSON.stringify({ questions: [{ question: 'Deploy?', options: [{ label: 'Later' }] }] })
    )

    expect(nativeChatAskDismissKey(first)).toBe(nativeChatAskDismissKey(same))
    expect(nativeChatAskDismissKey(first)).not.toBe(nativeChatAskDismissKey(changed))
    expect(nativeChatAskDismissKey(null)).toBeNull()
  })
})

describe('extractPendingAsk', () => {
  it('recognizes an unregistered tool whose input matches the canonical questions shape', () => {
    // The live path (parseAskFromStatus) accepts this shape from any tool name;
    // transcript replay must not silently drop the same pending question.
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

  it("clears the ask when its own result arrives, keeping the newest ask's identity", () => {
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
    // ESC on a running tool: Claude writes its interrupt record instead of a
    // tool result, so that call's FIFO slot never resolves (#11761).
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

  it('keeps an ask that is still awaiting its result after an earlier interrupt', () => {
    const pending = extractPendingAsk([
      message('m1', [call('Bash', { command: 'sleep 999' })]),
      interrupted('m2'),
      message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)])
    ])
    expect(pending?.questions[0]?.question).toBe('Deploy?')
  })

  it('drops an ask the user typed past instead of answering', () => {
    // Real transcripts hold asks that never get a result because the user
    // escaped the selector and sent a new prompt — the question is over.
    const pending = extractPendingAsk([
      message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      userTurn('m2', 'never mind, do this instead'),
      message('m3', [{ type: 'text', text: 'on it' }])
    ])
    expect(pending).toBeNull()
  })

  it('does not strand an answered ask behind an orphan left by a plain-text interrupt', () => {
    // Claude also writes the interrupt as a bare user turn (no
    // `interruptedMessageId`), which decodes as a user message, not a status row.
    const pending = extractPendingAsk([
      message('m1', [call('Bash', { command: 'sleep 999' })]),
      userTurn('m2', '[Request interrupted by user]'),
      message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      toolTurn('m4')
    ])
    expect(pending).toBeNull()
  })

  it('resolves an ask whose result arrives on its own tool-role turn', () => {
    const pending = extractPendingAsk([
      message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
      toolTurn('m2')
    ])
    expect(pending).toBeNull()
  })

  it('ignores malformed question payloads', () => {
    expect(
      extractPendingAsk([
        message('m1', [
          call('AskUserQuestion', { questions: [] }),
          call('AskUserQuestion', { questions: [{}] }),
          call('AskUserQuestion', 'not-an-object')
        ])
      ])
    ).toBeNull()
  })
})

describe('parseAskFromStatus', () => {
  it('accepts the canonical shape from any tool name and rejects broken JSON', () => {
    expect(
      parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT), 'SomeNewTool')?.questions
    ).toHaveLength(1)
    expect(parseAskFromStatus('{not json', 'AskUserQuestion')).toBeNull()
    expect(parseAskFromStatus(null)).toBeNull()
  })

  it('parses string options into labels', () => {
    const prompt = parseAskFromStatus(
      JSON.stringify({ questions: [{ question: 'Pick', options: ['a', 'b'] }] })
    )
    expect(prompt?.questions[0]?.options.map((o) => o.label)).toEqual(['a', 'b'])
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

  it('keeps a live ask authoritative while transcript history is unsettled', () => {
    const liveAsk = { questions: [{ question: 'Live?', options: [], multiSelect: false }] }
    expect(resolveNativeChatAsk({ liveAsk, messages: transcript, transcriptSettled: false })).toBe(
      liveAsk
    )
  })
})
