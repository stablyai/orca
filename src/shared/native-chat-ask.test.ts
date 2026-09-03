import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from './native-chat-types'
import {
  extractPendingAsk,
  isAskResolvedInTranscript,
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

  it('surfaces preview presence from a transcript tool-call, same as the live status path', () => {
    // Transcript replay decodes tool-call input as an object (not a JSON string,
    // unlike the hook-status path), but both route through the same option
    // parser, so preview presence must survive here too.
    const pending = extractPendingAsk([
      message('m1', [
        call('AskUserQuestion', {
          questions: [
            { question: 'Pick', options: [{ label: 'A', preview: 'snippet' }, { label: 'B' }] }
          ]
        })
      ])
    ])
    expect(pending?.questions[0]?.options).toEqual([
      { label: 'A', hasPreview: true },
      { label: 'B' }
    ])
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

  it('retires a live ask the settled transcript shows resolved', () => {
    // A question killed inside the TUI emits no hook, so live status holds it
    // forever; its tool-result is the only evidence it is over (#16865).
    const liveAsk = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!
    expect(
      resolveNativeChatAsk({
        liveAsk,
        messages: [message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]), toolTurn('m2')],
        transcriptSettled: true
      })
    ).toBeNull()
  })

  it('keeps a live ask asserted while the transcript is still unsettled', () => {
    const liveAsk = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!
    expect(
      resolveNativeChatAsk({
        liveAsk,
        messages: [message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]), toolTurn('m2')],
        transcriptSettled: false
      })
    ).toBe(liveAsk)
  })

  it('surfaces the transcript ask still pending when the live one is resolved', () => {
    const liveAsk = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!
    const later = { questions: [{ question: 'Ship it?', options: [{ label: 'Go' }] }] }
    const resolved = resolveNativeChatAsk({
      liveAsk,
      messages: [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m2'),
        message('m3', [call('AskUserQuestion', later)])
      ],
      transcriptSettled: true
    })
    expect(resolved?.questions[0]?.question).toBe('Ship it?')
  })

  it('keeps a cancelled ask retired after its interrupt row lands', () => {
    // The live repro: X cancels the selector, Claude writes the is_error result
    // then the interrupt row, and re-mounting the pane (view switch) must not
    // bring the dead question back.
    const liveAsk = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!
    expect(
      resolveNativeChatAsk({
        liveAsk,
        messages: [
          message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
          toolTurn('m2'),
          interrupted('m3'),
          userTurn('m4', 'ask me another question')
        ],
        transcriptSettled: true
      })
    ).toBeNull()
  })

  it('does not let a different pending ask suppress the live one', () => {
    const liveAsk = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!
    const other = { questions: [{ question: 'Other?', options: [{ label: 'A' }] }] }
    expect(
      resolveNativeChatAsk({
        liveAsk,
        messages: [message('m1', [call('AskUserQuestion', other)])],
        transcriptSettled: true
      })
    ).toBe(liveAsk)
  })
})

describe('isAskResolvedInTranscript', () => {
  const ask = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!

  it('reports resolved only once this ask receives its own FIFO result', () => {
    const calls = [message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)])]
    expect(isAskResolvedInTranscript(ask, calls)).toBe(false)
    expect(isAskResolvedInTranscript(ask, [...calls, toolTurn('m2')])).toBe(true)
  })

  it('is false when the transcript never mentions the ask', () => {
    expect(isAskResolvedInTranscript(ask, [])).toBe(false)
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('Bash', { command: 'ls' })]),
        toolTurn('m2')
      ])
    ).toBe(false)
  })

  it('does not credit a sibling call result to the ask', () => {
    // FIFO: the result settles the older Bash call, leaving the ask outstanding.
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('Bash', { command: 'ls' }), call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m2')
      ])
    ).toBe(false)
  })

  it('never reports resolved for an ask orphaned by an interrupt', () => {
    // The orphan's result never arrives, so a later result belongs to a call
    // from the next turn — crediting it would hide a live question (#11761).
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        interrupted('m2'),
        message('m3', [call('Bash', { command: 'ls' })]),
        toolTurn('m4')
      ])
    ).toBe(false)
  })

  it('never reports resolved for an ask orphaned by a new user turn', () => {
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        userTurn('m2', 'never mind'),
        message('m3', [call('Bash', { command: 'ls' })]),
        toolTurn('m4')
      ])
    ).toBe(false)
  })

  // Measured shape of a TUI-cancelled ask (Claude Code session transcripts): the
  // is_error tool-result lands first, then `[Request interrupted by user for tool
  // use]`. A verdict wiped by that trailing row let stale live status win again,
  // and remounting the pane (view switch) re-rendered the dead question.
  it('keeps the verdict when the cancel path writes its interrupt row after the result', () => {
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m2'),
        interrupted('m3'),
        userTurn('m4', 'ask me another question')
      ])
    ).toBe(true)
  })

  it('keeps the verdict when the interrupt arrives as a plain user row', () => {
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m2'),
        userTurn('m3', '[Request interrupted by user for tool use]')
      ])
    ).toBe(true)
  })

  it('un-resolves once the agent asks the same question again', () => {
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m2'),
        userTurn('m3', 'ask me that again'),
        message('m4', [call('AskUserQuestion', QUESTIONS_INPUT)])
      ])
    ).toBe(false)
  })

  it('re-arms after a reset so a re-asked question resolves on its own result', () => {
    expect(
      isAskResolvedInTranscript(ask, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        userTurn('m2', 'never mind'),
        message('m3', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m4')
      ])
    ).toBe(true)
  })

  it('matches by canonical content, not object identity', () => {
    const equivalent = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT))!
    expect(equivalent).not.toBe(ask)
    expect(
      isAskResolvedInTranscript(equivalent, [
        message('m1', [call('AskUserQuestion', QUESTIONS_INPUT)]),
        toolTurn('m2')
      ])
    ).toBe(true)
  })
})
