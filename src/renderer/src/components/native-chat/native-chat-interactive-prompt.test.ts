import { describe, expect, it } from 'vitest'

import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer
} from '../../../../shared/native-chat/input/native-chat-ask-answer'
import { parseAskFromStatus } from '../../../../shared/native-chat/input/native-chat-ask'

import type { AskPrompt } from '../../../../shared/native-chat/input/native-chat-ask-types'

describe('formatAskAnswer', () => {
  it('keeps one line per question with a blank middle answer (3 questions)', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'B' }] },
        { question: 'q3', multiSelect: false, options: [{ label: 'C' }] }
      ]
    }
    const answer = formatAskAnswer(prompt, [{ indices: [0] }, { indices: [] }, { indices: [0] }])
    expect(answer).toBe('A\n\nC')
    expect(answer.split('\n')).toHaveLength(3)
  })
})

const single = (options: string[], multiSelect = false): AskPrompt => ({
  questions: [{ question: 'q', multiSelect, options: options.map((label) => ({ label })) }]
})

describe('buildAskAnswerKeys', () => {
  it('single-select: sends the picked option NUMBER (not the label), no trailing Enter', () => {
    // Claude commits numbered selector markers; label-plus-Enter would choose the highlighted default instead.
    expect(buildAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [1] }])).toEqual([
      { raw: '2' }
    ])
    expect(buildAskAnswerKeys(single(['Apple', 'Banana', 'Cherry']), [{ indices: [2] }])).toEqual([
      { raw: '3' }
    ])
  })

  it('single-select free text: opens "Type something" then types the answer + Enter', () => {
    expect(
      buildAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [], other: 'Zebra' }])
    ).toEqual([{ raw: '3' }, { text: 'Zebra' }, { raw: '\r' }])
  })

  it('multi-select: toggles each option NUMBER, then steps to Submit and confirms', () => {
    expect(
      buildAskAnswerKeys(single(['Apple', 'Banana', 'Cherry'], true), [{ indices: [0, 2] }])
    ).toEqual([{ raw: '1' }, { raw: '3' }, { raw: '\x1b[C' }, { raw: '\r' }])
  })

  it('multi-question: steps past an unanswered question then submits', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] }
      ]
    }
    expect(buildAskAnswerKeys(prompt, [{ indices: [] }, { indices: [1] }])).toEqual([
      { raw: '\x1b[C' },
      { raw: '2' },
      { raw: '\r' }
    ])
  })

  it('preview single-select: focuses the option number, notes free text, then commits with Enter', () => {
    // #16865: Claude's preview selector only moves focus on a digit.
    const prompt = parseAskFromStatus(
      JSON.stringify({
        questions: [
          {
            question: 'Layout?',
            options: [
              { label: 'Alpha', preview: '+--+' },
              { label: 'Beta', preview: '|  |' }
            ]
          },
          { question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] }
        ]
      })
    )!
    expect(buildAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [1] }])).toEqual([
      { raw: '2' },
      { raw: '\r' },
      { raw: '2' },
      { raw: '\r' }
    ])
    expect(
      buildAskAnswerKeys(prompt, [{ indices: [1], other: 'wider' }, { indices: [0] }])
    ).toEqual([
      { raw: '2' },
      { raw: 'n' },
      { text: 'wider' },
      { raw: '\r' },
      { raw: '1' },
      { raw: '\r' }
    ])
    // Claude drops the pick on an unmoved first row, answering "(notes only)".
    expect(buildAskAnswerKeys(prompt, [{ indices: [0], other: 'wider' }, { indices: [] }])).toEqual(
      [
        { raw: '2' },
        { raw: '1' },
        { raw: 'n' },
        { text: 'wider' },
        { raw: '\r' },
        { raw: '\x1b[C' },
        { raw: '\r' }
      ]
    )
  })
})

describe('buildCodexAskAnswerKeys', () => {
  it("submits the final multi-question option without Claude's extra Enter", () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }

    expect(buildCodexAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [0] }])).toEqual([
      { raw: '2' },
      { raw: '1' }
    ])
  })

  it('adds free text as notes before committing the selected row', () => {
    expect(
      buildCodexAskAnswerKeys(single(['Tabs', 'Spaces']), [
        { indices: [1], other: 'Keep existing files' }
      ])
    ).toEqual([{ raw: '\x1b[B' }, { raw: '\t' }, { text: 'Keep existing files' }, { raw: '\r' }])
  })

  it("targets Codex's synthetic None-of-the-above row for a custom answer", () => {
    expect(
      buildCodexAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [], other: 'Four spaces' }])
    ).toEqual([{ raw: '\x1b[A' }, { raw: '\t' }, { text: 'Four spaces' }, { raw: '\r' }])
  })

  it('clears skipped rows and confirms the partial answer once', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }

    expect(buildCodexAskAnswerKeys(prompt, [{ indices: [] }, { indices: [1] }])).toEqual([
      { raw: '\x7f' },
      { raw: '\x1b[C' },
      { raw: '2' },
      { raw: '\r' }
    ])
  })
})
