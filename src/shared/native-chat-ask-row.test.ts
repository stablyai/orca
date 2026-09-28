import { describe, expect, it } from 'vitest'
import {
  hasNativeChatAskCall,
  nativeChatAskRunSubject,
  nativeChatAskRunBlocks
} from './native-chat-ask-row'
import {
  CODEX_RECORDED_CALL_ARGUMENTS,
  CODEX_RECORDED_OUTPUT,
  CODEX_RECORDED_PLAIN_OUTPUTS
} from './native-chat-ask-answers.test-fixture'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from './native-chat-types'

function askCall(input: unknown, name = 'AskUserQuestion'): NativeChatToolCallBlock {
  return { type: 'tool-call', name, input }
}

function toolResult(
  output: string,
  extra: Partial<NativeChatToolResultBlock> = {}
): NativeChatToolResultBlock {
  return { type: 'tool-result', output, ...extra }
}

describe('native chat ask row', () => {
  it('removes the question result without attaching it to another tool', () => {
    const ask = askCall({ questions: [{ question: 'Proceed?' }] })
    const answer: NativeChatBlock = { type: 'tool-result', output: 'yes' }
    const read: NativeChatBlock = { type: 'tool-call', name: 'Read', input: {} }
    const output: NativeChatBlock = { type: 'tool-result', output: 'file contents' }
    expect(nativeChatAskRunBlocks([ask, read, answer, output])).toEqual({
      asks: [{ call: ask, result: answer }],
      unansweredAsks: [],
      work: [read, output]
    })
  })

  it('keeps an ask open only until its FIFO result arrives', () => {
    const ask = askCall({ questions: [{ question: 'Proceed?' }] })
    expect(nativeChatAskRunBlocks([ask])).toEqual({
      asks: [{ call: ask }],
      unansweredAsks: [ask],
      work: []
    })
  })
  it('names the one question a prompt asks', () => {
    expect(
      nativeChatAskRunSubject([{ call: askCall({ questions: [{ question: 'Which branch?' }] }) }])
    ).toEqual({ kind: 'question', text: 'Which branch?' })
  })

  it('counts a grouped prompt rather than quoting only its first question', () => {
    expect(
      nativeChatAskRunSubject([
        { call: askCall({ questions: [{ question: 'Which branch?' }, { question: 'Proceed?' }] }) }
      ])
    ).toEqual({
      kind: 'questions',
      questions: [{ text: 'Which branch?' }, { text: 'Proceed?' }]
    })
  })

  it('aggregates the per-question calls Codex journals for a single prompt', () => {
    // Codex writes one call per question, so a per-call row would stack two
    // pulsing lines for a prompt the reader was shown once.
    expect(
      nativeChatAskRunSubject([
        { call: askCall({ questions: [{ question: 'Which branch?' }] }, 'request_user_input') },
        { call: askCall({ questions: [{ question: 'Proceed?' }] }, 'request_user_input') }
      ])
    ).toEqual({
      kind: 'questions',
      questions: [{ text: 'Which branch?' }, { text: 'Proceed?' }]
    })
  })

  it('decodes the JSON-string arguments Codex delivers', () => {
    expect(
      nativeChatAskRunSubject([
        {
          call: askCall(
            JSON.stringify({ questions: [{ question: 'Which branch?' }] }),
            'request_user_input'
          )
        }
      ])
    ).toEqual({ kind: 'question', text: 'Which branch?' })
  })

  it('still reports an ask whose payload names no question', () => {
    // Decided by the tool name alone: an unreadable payload must not put the raw
    // call back on screen as the row it was meant to replace.
    const call = askCall({ prompt: 'which?' })

    expect(hasNativeChatAskCall([call])).toBe(true)
    expect(nativeChatAskRunSubject([{ call }])).toBeNull()
  })

  it('leaves an ordinary tool call alone even when its input carries questions', () => {
    expect(hasNativeChatAskCall([askCall({ questions: [{ question: 'x' }] }, 'Read')])).toBe(false)
  })

  describe('answers', () => {
    const CLAUDE_INPUT = {
      questions: [
        { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
        { question: 'Which features?', multiSelect: true, options: [{ label: 'Auth' }] }
      ]
    }

    it('joins the answers Claude recorded to each question by its exact text', () => {
      const result = toolResult('prose the model reads', {
        askAnswers: [
          { question: 'Which features?', answer: ['Auth', 'Billing'] },
          { question: 'Which database?', answer: ['Postgres'] }
        ]
      })
      expect(nativeChatAskRunSubject([{ call: askCall(CLAUDE_INPUT), result }])).toEqual({
        kind: 'questions',
        questions: [
          { text: 'Which database?', answer: 'Postgres' },
          { text: 'Which features?', answer: 'Auth · Billing' }
        ]
      })
    })

    it('shows only the questions of a result from a host that recorded no answers', () => {
      // The prose names the answers, but it varies by release and quotes them unescaped.
      const result = toolResult('User has answered your questions: "Which database?"="Postgres"')
      expect(nativeChatAskRunSubject([{ call: askCall(CLAUDE_INPUT), result }])).toEqual({
        kind: 'questions',
        questions: [{ text: 'Which database?' }, { text: 'Which features?' }]
      })
    })

    it('answers the one question a prompt asks', () => {
      const call = askCall({ questions: [{ question: 'Which database?' }] })
      const result = toolResult('', {
        askAnswers: [{ question: 'Which database?', answer: ['Something I typed'] }]
      })
      expect(nativeChatAskRunSubject([{ call, result }])).toEqual({
        kind: 'question',
        text: 'Which database?',
        answer: 'Something I typed'
      })
    })

    it('joins Codex answers by question id across the calls of one prompt', () => {
      const call = (id: string, question: string): NativeChatToolCallBlock =>
        askCall(
          JSON.stringify({ questions: [{ id, question, header: 'H' }] }),
          'request_user_input'
        )
      const answered = (id: string, answers: string[]): NativeChatToolResultBlock =>
        toolResult(JSON.stringify({ answers: { [id]: { answers } } }))
      expect(
        nativeChatAskRunSubject([
          { call: call('branch', 'Which branch?'), result: answered('branch', ['main']) },
          {
            call: call('scope', 'How wide?'),
            result: answered('scope', ['None of the above', 'user_note: only the parser'])
          },
          { call: call('later', 'Anything else?') }
        ])
      ).toEqual({
        kind: 'questions',
        questions: [
          { id: 'branch', text: 'Which branch?', answer: 'main' },
          { id: 'scope', text: 'How wide?', answer: 'None of the above · only the parser' },
          { id: 'later', text: 'Anything else?' }
        ]
      })
    })

    it('joins each answer of a multi-question Codex call to its own question', () => {
      const call = askCall(
        JSON.stringify({
          questions: [
            { id: 'a', question: 'First?' },
            { id: 'b', question: 'Second?' },
            { id: 'c', question: 'Third?' }
          ]
        }),
        'request_user_input'
      )
      const result = toolResult(
        JSON.stringify({
          answers: { c: { answers: ['Three'] }, a: { answers: ['One'] }, b: { answers: [] } }
        })
      )
      expect(nativeChatAskRunSubject([{ call, result }])).toEqual({
        kind: 'questions',
        questions: [
          { id: 'a', text: 'First?', answer: 'One' },
          { id: 'b', text: 'Second?' },
          { id: 'c', text: 'Third?', answer: 'Three' }
        ]
      })
    })

    it('never shows the answer to a secret question', () => {
      const call = askCall(
        JSON.stringify({
          questions: [
            { id: 'token', question: 'API token?', isSecret: true },
            { id: 'name', question: 'Project name?' }
          ]
        }),
        'request_user_input'
      )
      const result = toolResult(
        JSON.stringify({
          answers: { token: { answers: ['sk-secret'] }, name: { answers: ['orca'] } }
        })
      )
      const subject = nativeChatAskRunSubject([{ call, result }])
      expect(subject).toEqual({
        kind: 'questions',
        questions: [
          { id: 'token', text: 'API token?' },
          { id: 'name', text: 'Project name?', answer: 'orca' }
        ]
      })
      expect(JSON.stringify(subject)).not.toContain('sk-secret')
    })

    it('shows only the question when Codex refused or the reader aborted', () => {
      const call = askCall(
        JSON.stringify({ questions: [{ id: 'branch', question: 'Which branch?' }] }),
        'request_user_input'
      )
      for (const output of CODEX_RECORDED_PLAIN_OUTPUTS) {
        expect(nativeChatAskRunSubject([{ call, result: toolResult(output) }])).toEqual({
          kind: 'question',
          id: 'branch',
          text: 'Which branch?'
        })
      }
    })

    it('shows only the questions a prose-only agent asked', () => {
      const call = askCall({ questions: [{ question: 'Proceed?' }] }, 'ask_user_question')
      expect(nativeChatAskRunSubject([{ call, result: toolResult('User selected: Yes') }])).toEqual(
        { kind: 'question', text: 'Proceed?' }
      )
    })

    it('answers a recorded Codex prompt from its output', () => {
      const call = askCall(CODEX_RECORDED_CALL_ARGUMENTS, 'request_user_input')
      expect(
        nativeChatAskRunSubject([{ call, result: toolResult(CODEX_RECORDED_OUTPUT) }])
      ).toEqual({
        kind: 'question',
        id: 'fix_scope',
        text: 'How wide should the fix go this time?',
        answer: 'Only the parser'
      })
    })

    it('shows only the question when Codex output names an id the call did not ask', () => {
      const call = askCall(CODEX_RECORDED_CALL_ARGUMENTS, 'request_user_input')
      const result = toolResult(
        JSON.stringify({
          answers: { fix_scope: { answers: ['Both'] }, other: { answers: ['x'] } }
        })
      )
      expect(nativeChatAskRunSubject([{ call, result }])).toEqual({
        kind: 'question',
        id: 'fix_scope',
        text: 'How wide should the fix go this time?'
      })
    })

    it("reads another agent's output as Codex's only when the tool is Codex's", () => {
      // Same ids and output shape as Codex, from an agent whose results are prose.
      const call = askCall(
        { questions: [{ id: 'branch', question: 'Which branch?' }] },
        'ask_user_question'
      )
      const result = toolResult(JSON.stringify({ answers: { branch: { answers: ['main'] } } }))
      expect(nativeChatAskRunSubject([{ call, result }])).toEqual({
        kind: 'question',
        id: 'branch',
        text: 'Which branch?'
      })
    })

    it('never reads text-keyed answers on a Codex call', () => {
      const call = askCall(CODEX_RECORDED_CALL_ARGUMENTS, 'request_user_input')
      const result = toolResult('aborted by user after 2.0s', {
        askAnswers: [{ question: 'How wide should the fix go this time?', answer: ['Both'] }]
      })
      expect(nativeChatAskRunSubject([{ call, result }])).toEqual({
        kind: 'question',
        id: 'fix_scope',
        text: 'How wide should the fix go this time?'
      })
    })
  })
})
