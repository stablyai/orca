import { describe, expect, it } from 'vitest'
import { nativeChatAskRunSubject, nativeChatAskRunBlocks } from './native-chat-ask-row'
import type { NativeChatBlock } from '../../native-chat-types'

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

  it('aggregates the per-question calls Codex journals for a single prompt', () => {
    // Codex journals one call per question; aggregate the prompt to avoid duplicate pulsing rows.
    expect(
      nativeChatAskRunSubject([
        askCall({ questions: [{ question: 'Which branch?' }] }, 'request_user_input'),
        askCall({ questions: [{ question: 'Proceed?' }] }, 'request_user_input')
      ])
    ).toEqual({ kind: 'questions', questions: ['Which branch?', 'Proceed?'] })
  })
})
