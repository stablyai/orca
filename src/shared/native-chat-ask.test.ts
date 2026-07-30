import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'
import { extractPendingAsk, parseAskFromStatus } from './native-chat-ask'

function message(id: string, blocks: NativeChatBlock[]): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

function call(name: string, input: unknown): NativeChatBlock {
  return { type: 'tool-call', name, input }
}

function result(): NativeChatBlock {
  return { type: 'tool-result', output: 'ok' }
}

const QUESTIONS_INPUT = {
  questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }]
}

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
