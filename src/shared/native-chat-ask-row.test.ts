import { describe, expect, it } from 'vitest'
import {
  hasNativeChatAskCall,
  nativeChatAskRunSubject,
  nativeChatAskRunBlocks
} from './native-chat-ask-row'
import type { NativeChatBlock } from './native-chat-types'

function askCall(input: unknown, name = 'AskUserQuestion'): NativeChatBlock {
  return { type: 'tool-call', name, input }
}

describe('native chat ask row', () => {
  it('removes the question result without attaching it to another tool', () => {
    const ask = askCall({ questions: [{ question: 'Proceed?' }] })
    const answer: NativeChatBlock = { type: 'tool-result', output: 'yes' }
    const read: NativeChatBlock = { type: 'tool-call', name: 'Read', input: {} }
    const output: NativeChatBlock = { type: 'tool-result', output: 'file contents' }
    expect(nativeChatAskRunBlocks([ask, read, answer, output])).toEqual({
      asks: [ask],
      unansweredAsks: [],
      work: [read, output]
    })
  })

  it('keeps an ask open only until its FIFO result arrives', () => {
    const ask = askCall({ questions: [{ question: 'Proceed?' }] })
    expect(nativeChatAskRunBlocks([ask])).toEqual({
      asks: [ask],
      unansweredAsks: [ask],
      work: []
    })
  })
  it('names the one question a prompt asks', () => {
    expect(
      nativeChatAskRunSubject([askCall({ questions: [{ question: 'Which branch?' }] })])
    ).toEqual({ kind: 'question', text: 'Which branch?' })
  })

  it('counts a grouped prompt rather than quoting only its first question', () => {
    expect(
      nativeChatAskRunSubject([
        askCall({ questions: [{ question: 'Which branch?' }, { question: 'Proceed?' }] })
      ])
    ).toEqual({ kind: 'count', count: 2 })
  })

  it('aggregates the per-question calls Codex journals for a single prompt', () => {
    // Codex writes one call per question, so a per-call row would stack two
    // pulsing lines for a prompt the reader was shown once.
    expect(
      nativeChatAskRunSubject([
        askCall({ questions: [{ question: 'Which branch?' }] }, 'request_user_input'),
        askCall({ questions: [{ question: 'Proceed?' }] }, 'request_user_input')
      ])
    ).toEqual({ kind: 'count', count: 2 })
  })

  it('decodes the JSON-string arguments Codex delivers', () => {
    expect(
      nativeChatAskRunSubject([
        askCall(
          JSON.stringify({ questions: [{ question: 'Which branch?' }] }),
          'request_user_input'
        )
      ])
    ).toEqual({ kind: 'question', text: 'Which branch?' })
  })

  it('still reports an ask whose payload names no question', () => {
    // Decided by the tool name alone: an unreadable payload must not put the raw
    // call back on screen as the row it was meant to replace.
    const blocks = [askCall({ prompt: 'which?' })]

    expect(hasNativeChatAskCall(blocks)).toBe(true)
    expect(nativeChatAskRunSubject(blocks)).toBeNull()
  })

  it('leaves an ordinary tool call alone even when its input carries questions', () => {
    expect(hasNativeChatAskCall([askCall({ questions: [{ question: 'x' }] }, 'Read')])).toBe(false)
  })
})
