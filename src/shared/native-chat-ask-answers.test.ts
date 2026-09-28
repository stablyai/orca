import { describe, expect, it } from 'vitest'
import { claudeAskAnswers, codexAskAnswers } from './native-chat-ask-answers'
import {
  CLAUDE_DECLINED_RESULTS,
  CLAUDE_RECORDED_MULTI_SELECT_LIST,
  CLAUDE_RECORDED_PREVIEW_ANSWER,
  CLAUDE_RECORDED_TYPED_ANSWER,
  CODEX_RECORDED_OUTPUT,
  CODEX_RECORDED_PLAIN_OUTPUTS
} from './native-chat-ask-answers.test-fixture'

// Shapes no local record showed are written to Claude Code's published
// `AskUserQuestionOutput` type, plus the optional `followUp` flag its CLI records.
const QUESTION = 'Which storage for the cache?'
const ONE_QUESTION = CLAUDE_RECORDED_MULTI_SELECT_LIST.questions.slice(0, 1)

describe('claudeAskAnswers', () => {
  it('keeps a recorded label, and each label of a multi-select list', () => {
    expect(claudeAskAnswers(CLAUDE_RECORDED_MULTI_SELECT_LIST)).toEqual([
      { question: QUESTION, answer: ['On disk'] },
      { question: 'Which checks run?', answer: ['Lint', 'Tests'] }
    ])
  })

  it('keeps recorded typed text whole, commas and quotes included', () => {
    expect(claudeAskAnswers(CLAUDE_RECORDED_TYPED_ANSWER)).toEqual([
      {
        question: 'How should the importer treat duplicate rows?',
        answer: ['Merge them, "newest" wins']
      }
    ])
  })

  it('reads past a recorded preview, which is the option content, not the reply', () => {
    expect(claudeAskAnswers(CLAUDE_RECORDED_PREVIEW_ANSWER)).toEqual([
      { question: 'Which layout for the header?', answer: ['Stacked'] },
      { question: 'Ship it behind a flag?', answer: ['Yes'] }
    ])
  })

  it('reads nothing from a declined prompt, recorded as text', () => {
    for (const declined of CLAUDE_DECLINED_RESULTS) {
      expect(claudeAskAnswers(declined)).toBeNull()
    }
  })

  it('adds a note the reader typed after the option it annotates', () => {
    expect(
      claudeAskAnswers({
        questions: CLAUDE_RECORDED_MULTI_SELECT_LIST.questions,
        answers: { [QUESTION]: 'On disk' },
        annotations: {
          [QUESTION]: { notes: 'but compress it' },
          'Which checks run?': { notes: 'whatever is fastest' }
        }
      })
    ).toEqual([
      { question: QUESTION, answer: ['On disk', 'but compress it'] },
      { question: 'Which checks run?', answer: ['whatever is fastest'] }
    ])
  })

  it("shows the note, not Claude's stand-in, when no option was chosen", () => {
    expect(
      claudeAskAnswers({
        questions: ONE_QUESTION,
        answers: { [QUESTION]: '(notes only)' },
        annotations: { [QUESTION]: { notes: 'ask the team first' } }
      })
    ).toEqual([{ question: QUESTION, answer: ['ask the team first'] }])
  })

  it('reads nothing for picks the reader never submitted', () => {
    expect(
      claudeAskAnswers({
        questions: ONE_QUESTION,
        answers: { [QUESTION]: 'On disk' },
        afkTimeoutMs: 60_000
      })
    ).toBeNull()
  })

  it('reads nothing when the reader typed a response in place of the answers', () => {
    expect(
      claudeAskAnswers({
        questions: ONE_QUESTION,
        answers: { [QUESTION]: 'On disk' },
        response: 'Neither, let me explain first.'
      })
    ).toBeNull()
  })

  it('keeps the answers given before the reader asked for follow-up questions', () => {
    expect(
      claudeAskAnswers({
        questions: ONE_QUESTION,
        answers: { [QUESTION]: 'On disk' },
        response: 'Also ask about eviction.',
        followUp: true
      })
    ).toEqual([{ question: QUESTION, answer: ['On disk'] }])
  })

  describe('reads nothing from a shape it does not recognize', () => {
    const answered = { questions: ONE_QUESTION, answers: { [QUESTION]: 'On disk' } }

    it('an unknown top-level key', () => {
      expect(claudeAskAnswers(answered)).not.toBeNull()
      expect(claudeAskAnswers({ ...answered, submittedBy: 'someone' })).toBeNull()
    })

    it('an unknown annotation key', () => {
      expect(
        claudeAskAnswers({ ...answered, annotations: { [QUESTION]: { notes: 'fine' } } })
      ).not.toBeNull()
      expect(
        claudeAskAnswers({ ...answered, annotations: { [QUESTION]: { draft: 'fine' } } })
      ).toBeNull()
    })

    it('an answer under a question that was not asked', () => {
      expect(
        claudeAskAnswers({ ...answered, answers: { [QUESTION]: 'On disk', 'Which cache?': 'x' } })
      ).toBeNull()
    })

    it('an answer that is not text', () => {
      const questions = CLAUDE_RECORDED_MULTI_SELECT_LIST.questions
      expect(
        claudeAskAnswers({ questions, answers: { [QUESTION]: 'On disk', 'Which checks run?': 2 } })
      ).toBeNull()
      expect(claudeAskAnswers({ ...answered, answers: { [QUESTION]: ['On disk', 2] } })).toBeNull()
    })

    it('a result of another tool', () => {
      expect(claudeAskAnswers({ answers: { 'a?': 'b' }, stdout: 'ok' })).toBeNull()
    })
  })
})

const CODEX_IDS = new Set(['branch', 'scope', 'fix_scope'])

function output(answers: Record<string, string[]>): string {
  return JSON.stringify({
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, list]) => [id, { answers: list }])
    )
  })
}

describe('codexAskAnswers', () => {
  it('reads a recorded answer under its question id', () => {
    expect(codexAskAnswers(CODEX_RECORDED_OUTPUT, CODEX_IDS)).toEqual(
      new Map([['fix_scope', ['Only the parser']]])
    )
  })

  it('reads each answer under its question id', () => {
    expect(codexAskAnswers(output({ branch: ['main'], scope: ['Only tests'] }), CODEX_IDS)).toEqual(
      new Map([
        ['branch', ['main']],
        ['scope', ['Only tests']]
      ])
    )
  })

  it('strips the marker Codex puts on text the reader typed', () => {
    expect(
      codexAskAnswers(output({ scope: ['Only tests', 'user_note: and the docs'] }), CODEX_IDS)
    ).toEqual(new Map([['scope', ['Only tests', 'and the docs']]]))
  })

  it('keeps the "None of the above" choice beside the text typed in its place', () => {
    expect(
      codexAskAnswers(
        output({ scope: ['None of the above', 'user_note: just the parser'] }),
        CODEX_IDS
      )
    ).toEqual(new Map([['scope', ['None of the above', 'just the parser']]]))
  })

  it('records no answer for a question left unanswered', () => {
    expect(codexAskAnswers(output({ branch: [], scope: ['user_note:  '] }), CODEX_IDS)).toEqual(
      new Map()
    )
  })

  it('reads nothing from a recorded refusal or abort, which are plain text', () => {
    for (const plain of CODEX_RECORDED_PLAIN_OUTPUTS) {
      expect(codexAskAnswers(plain, CODEX_IDS)).toBeNull()
    }
  })

  describe('reads nothing from a shape it does not recognize', () => {
    it('JSON of another tool', () => {
      expect(codexAskAnswers('{"output":"ok"}', CODEX_IDS)).toBeNull()
      expect(codexAskAnswers('[1,2]', CODEX_IDS)).toBeNull()
    })

    it('an extra key beside the answers', () => {
      expect(
        codexAskAnswers(
          JSON.stringify({ answers: { branch: { answers: ['main'] } }, skipped: true }),
          CODEX_IDS
        )
      ).toBeNull()
      expect(
        codexAskAnswers(
          JSON.stringify({ answers: { branch: { answers: ['main'], secret: true } } }),
          CODEX_IDS
        )
      ).toBeNull()
    })

    it('an id the call did not ask', () => {
      expect(codexAskAnswers(output({ branch: ['main'], other: ['x'] }), CODEX_IDS)).toBeNull()
    })

    it('an entry or item that is not a list of text', () => {
      expect(codexAskAnswers(JSON.stringify({ answers: { branch: 'main' } }), CODEX_IDS)).toBeNull()
      expect(
        codexAskAnswers(
          JSON.stringify({ answers: { branch: { answers: ['main', 1] } } }),
          CODEX_IDS
        )
      ).toBeNull()
    })
  })
})
