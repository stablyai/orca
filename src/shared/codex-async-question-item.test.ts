import { describe, expect, it } from 'vitest'
import {
  attachCodexAsyncQuestions,
  readCodexAsyncQuestionCallArguments,
  readCodexAsyncQuestions
} from './codex-async-question-item'

describe('readCodexAsyncQuestions', () => {
  it('reads titles and options of an async message', () => {
    expect(
      readCodexAsyncQuestions({
        delivery: 'async',
        questions: [{ title: 'Color?', options: ['Red', 'Blue'] }, { title: 'Why?' }]
      })
    ).toEqual([{ title: 'Color?', options: ['Red', 'Blue'] }, { title: 'Why?' }])
  })

  it('ignores a message without async delivery', () => {
    expect(readCodexAsyncQuestions({ questions: [{ title: 'Color?' }] })).toBeNull()
    expect(readCodexAsyncQuestions({ delivery: 'sync', questions: [{ title: 'x' }] })).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(readCodexAsyncQuestions({ delivery: 'async', questions: [] })).toBeNull()
    expect(readCodexAsyncQuestions({ delivery: 'async', questions: [{ title: ' ' }] })).toBeNull()
    expect(readCodexAsyncQuestions({ delivery: 'async', questions: [{ title: 1 }] })).toBeNull()
    expect(
      readCodexAsyncQuestions({ delivery: 'async', questions: [{ title: 'x', options: [1] }] })
    ).toBeNull()
    expect(readCodexAsyncQuestions(null)).toBeNull()
  })

  it('bounds options and titles the way Codex does', () => {
    const options = Array.from({ length: 40 }, (_, index) => `o${index}`)
    options[1] = 'y'.repeat(513)
    const [question] =
      readCodexAsyncQuestions({
        delivery: 'async',
        questions: [{ title: 'é'.repeat(400), options }]
      }) ?? []
    expect(question?.options).toHaveLength(31)
    expect(question?.options).not.toContain('y'.repeat(513))
    expect(new TextEncoder().encode(question?.title).length).toBeLessThanOrEqual(512)
  })

  it('reads call arguments given as JSON text or an object', () => {
    const questions = [{ title: 'Color?' }]
    expect(readCodexAsyncQuestionCallArguments(JSON.stringify({ questions }))).toEqual(questions)
    expect(readCodexAsyncQuestionCallArguments({ questions })).toEqual(questions)
    expect(readCodexAsyncQuestionCallArguments('{')).toBeNull()
  })

  it('attaches questions to the first text block only for async messages', () => {
    const blocks = [{ type: 'text' as const, text: 'Color?' }]
    expect(
      attachCodexAsyncQuestions(
        blocks,
        { delivery: 'async', questions: [{ title: 'Color?' }] },
        'i'
      )
    ).toEqual([
      {
        type: 'text',
        text: 'Color?',
        asyncQuestions: { providerItemId: 'i', questions: [{ title: 'Color?' }] }
      }
    ])
    expect(attachCodexAsyncQuestions(blocks, { text: 'plain' }, 'i')).toBe(blocks)
  })
})
