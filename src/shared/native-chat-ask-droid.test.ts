import { describe, expect, it } from 'vitest'
import { buildDroidAskAnswerKeys } from './native-chat-ask-droid-keys'
import { parseDroidQuestionnaire } from './native-chat-ask-droid-questionnaire'
import { parseAskFromStatus, type AskAnswerSelection, type AskPrompt } from './native-chat-ask'

const ENTER = '\r'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const TAB = '\t'

const questionnaire = (text: string): { questionnaire: string } => ({ questionnaire: text })

describe('parseDroidQuestionnaire', () => {
  it('rejects anything that is not a questionnaire string', () => {
    expect(parseDroidQuestionnaire(null)).toBeNull()
    expect(parseDroidQuestionnaire({})).toBeNull()
    expect(parseDroidQuestionnaire({ questionnaire: 42 })).toBeNull()
    expect(parseDroidQuestionnaire(questionnaire('just prose, no markers'))).toBeNull()
  })

  it('parses the numbered marker form Droid documents', () => {
    expect(
      parseDroidQuestionnaire(
        questionnaire(
          [
            '1. [question] Which remote should origin point at?',
            '[topic] Remote',
            '[option] ranaroussi/orca',
            '[option] stablyai/orca',
            '',
            '2. [question] Which surfaces get the flag? (multi)',
            '[topic] Reversed layout',
            '[option] Desktop',
            '[option] Mobile'
          ].join('\n')
        )
      )
    ).toEqual({
      questions: [
        {
          question: 'Which remote should origin point at?',
          header: 'Remote',
          multiSelect: false,
          options: [{ label: 'ranaroussi/orca' }, { label: 'stablyai/orca' }]
        },
        {
          question: 'Which surfaces get the flag?',
          header: 'Reversed-layout',
          multiSelect: true,
          options: [{ label: 'Desktop' }, { label: 'Mobile' }]
        }
      ]
    })
  })

  it('accepts bare markers with no numbering and no topic', () => {
    expect(
      parseDroidQuestionnaire(
        questionnaire(['[question] Ship it?', '[option] Yes', '[option] Later'].join('\n'))
      )
    ).toEqual({
      questions: [
        {
          question: 'Ship it?',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'Later' }]
        }
      ]
    })
  })

  it('defaults an option-less question to Yes/No', () => {
    expect(parseDroidQuestionnaire(questionnaire('[question] Proceed?'))?.questions[0]).toEqual({
      question: 'Proceed?',
      multiSelect: false,
      options: [{ label: 'Yes' }, { label: 'No' }]
    })
  })

  it('splits markers crammed onto one line', () => {
    expect(
      parseDroidQuestionnaire(
        questionnaire('1. [question] Pick one? [topic] Pick [option] A [option] B')
      )
    ).toEqual({
      questions: [
        {
          question: 'Pick one?',
          header: 'Pick',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }]
        }
      ]
    })
  })

  it('reads the fenced block and drops headers, fences, and preamble', () => {
    const parsed = parseDroidQuestionnaire(
      questionnaire(
        [
          'Some preamble the model added.',
          '```markdown',
          '## Heading',
          '[question] Which one?',
          '[option] A',
          '[option] B',
          '```'
        ].join('\n')
      )
    )
    expect(parsed?.questions).toEqual([
      {
        question: 'Which one?',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }]
      }
    ])
  })

  it('folds a wrapped question body into the question text', () => {
    expect(
      parseDroidQuestionnaire(
        questionnaire(
          [
            '[question] Which approach?',
            'It changes how launch args are emitted.',
            '[option] Flag',
            '[option] Settings file'
          ].join('\n')
        )
      )?.questions[0]?.question
    ).toBe('Which approach?\nIt changes how launch args are emitted.')
  })

  it('opens an implicit numbered question only when its options follow', () => {
    expect(
      parseDroidQuestionnaire(
        questionnaire(['1. Which one?', '[option] A', '[option] B'].join('\n'))
      )?.questions
    ).toEqual([
      { question: 'Which one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
    ])
    expect(parseDroidQuestionnaire(questionnaire('1. Just a numbered sentence.'))).toBeNull()
  })

  // A card must never appear for a questionnaire whose selector is showing a
  // format error: its options do not exist, so every keystroke would misfire.
  it('rejects what Droid itself rejects', () => {
    expect(parseDroidQuestionnaire(questionnaire('[question]'))).toBeNull()
    expect(parseDroidQuestionnaire(questionnaire('[option] orphan'))).toBeNull()
    expect(parseDroidQuestionnaire(questionnaire('[topic] orphan'))).toBeNull()
    expect(
      parseDroidQuestionnaire(
        questionnaire(['[question] Pick?', '[option] A', '[option] a'].join('\n'))
      )
    ).toBeNull()
    const elevenOptions = ['[question] Pick?'].concat(
      Array.from({ length: 11 }, (_, index) => `[option] ${index}`)
    )
    expect(parseDroidQuestionnaire(questionnaire(elevenOptions.join('\n')))).toBeNull()
    const elevenQuestions = Array.from(
      { length: 11 },
      (_, index) => `[question] Q${index}\n[option] A\n[option] B`
    )
    expect(parseDroidQuestionnaire(questionnaire(elevenQuestions.join('\n')))).toBeNull()
  })

  it('is the registered parser for the AskUser tool', () => {
    const prompt = parseAskFromStatus(
      JSON.stringify(questionnaire('[question] Ship?\n[option] Yes\n[option] No')),
      'AskUser'
    )
    expect(prompt?.questions[0]?.options).toEqual([{ label: 'Yes' }, { label: 'No' }])
  })
})

const prompt = (...questions: AskPrompt['questions']): AskPrompt => ({ questions })
const single = (...labels: string[]): AskPrompt['questions'][number] => ({
  question: 'q',
  multiSelect: false,
  options: labels.map((label) => ({ label }))
})
const multi = (...labels: string[]): AskPrompt['questions'][number] => ({
  ...single(...labels),
  multiSelect: true
})
const pick = (...indices: number[]): AskAnswerSelection => ({ indices })

describe('buildDroidAskAnswerKeys', () => {
  it('walks down to the picked option and commits it', () => {
    expect(buildDroidAskAnswerKeys(prompt(single('A', 'B', 'C')), [pick(2)])).toEqual([
      { raw: DOWN },
      { raw: DOWN },
      { raw: ENTER }
    ])
  })

  it('commits the first option with no navigation', () => {
    expect(buildDroidAskAnswerKeys(prompt(single('A', 'B')), [pick(0)])).toEqual([{ raw: ENTER }])
  })

  it('sends free text as one printable input, then commits', () => {
    expect(
      buildDroidAskAnswerKeys(prompt(single('A', 'B')), [{ indices: [], other: 'something  else' }])
    ).toEqual([{ text: 'something else' }, { raw: ENTER }])
  })

  it('folds a picked label into the free-text answer a single-select can carry', () => {
    expect(
      buildDroidAskAnswerKeys(prompt(single('A', 'B')), [{ indices: [1], other: 'and more' }])
    ).toEqual([{ text: 'B, and more' }, { raw: ENTER }])
  })

  it('toggles each checkbox in row order, then submits with right-arrow', () => {
    expect(buildDroidAskAnswerKeys(prompt(multi('A', 'B', 'C')), [pick(2, 0)])).toEqual([
      { raw: ENTER },
      { raw: DOWN },
      { raw: DOWN },
      { raw: ENTER },
      { raw: RIGHT }
    ])
  })

  it('submits a multi-select free-text answer through the Continue row', () => {
    expect(
      buildDroidAskAnswerKeys(prompt(multi('A', 'B')), [{ indices: [0], other: 'plus this' }])
    ).toEqual([{ raw: ENTER }, { text: 'plus this' }, { raw: ENTER }, { raw: ENTER }])
  })

  it('relies on the selector auto-advancing between answered questions', () => {
    expect(
      buildDroidAskAnswerKeys(prompt(single('A', 'B'), single('C', 'D')), [pick(1), pick(0)])
    ).toEqual([{ raw: DOWN }, { raw: ENTER }, { raw: ENTER }])
  })

  // The selector jumps to the next question with no answer yet, so a skipped
  // question leaves the cursor there and later keystrokes must account for it.
  it('tabs across a skipped question instead of assuming the cursor advanced', () => {
    expect(
      buildDroidAskAnswerKeys(prompt(single('A', 'B'), single('C', 'D'), single('E', 'F')), [
        pick(0),
        { indices: [] },
        pick(1)
      ])
    ).toEqual([{ raw: ENTER }, { raw: TAB }, { raw: DOWN }, { raw: ENTER }])
  })

  it('sends nothing when no question carries an answer', () => {
    expect(buildDroidAskAnswerKeys(prompt(single('A', 'B')), [{ indices: [] }])).toEqual([])
  })
})
