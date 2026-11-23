import { describe, expect, it } from 'vitest'
import {
  codeInputSegments,
  completionWordAt,
  insideString,
  matchCompletions
} from './plugin-declarative-code-input-text'

describe('completionWordAt', () => {
  it('takes operators and dotted paths whole', () => {
    expect(completionWordAt('{ a: { $g', 9)).toEqual({ from: 7, word: '$g' })
    expect(completionWordAt('{ address.ci', 12)).toEqual({ from: 2, word: 'address.ci' })
    expect(completionWordAt('{ ', 2)).toEqual({ from: 2, word: '' })
  })
})

describe('insideString', () => {
  it('is inside an open string only, past escapes, and a line break closes all but a backtick', () => {
    const quotes = `'"\``
    expect(insideString("{ a: 'sh", 8, quotes)).toBe(true)
    expect(insideString("{ a: 'x', b: tr", 15, quotes)).toBe(false)
    expect(insideString('{ a: "it\\"s', 11, quotes)).toBe(true)
    expect(insideString("{ a: 'x\n  b", 11, quotes)).toBe(false)
    expect(insideString('{ a: `x\n  b', 11, quotes)).toBe(true)
    expect(insideString("{ a: 'sh", 8, undefined)).toBe(false)
  })
})

describe('matchCompletions', () => {
  it('puts prefix matches before inner ones and drops the word already typed', () => {
    const items = [{ label: 'createdAt' }, { label: 'name' }, { label: 'surname' }, { label: 'na' }]
    expect(matchCompletions(items, 'na').map((item) => item.label)).toEqual(['name', 'surname'])
  })
})

describe('codeInputSegments', () => {
  it('cuts at diagnostic edges and the caret, keeping the earlier of two overlapping ranges', () => {
    expect(
      codeInputSegments(
        '{ a: tru }',
        [
          { from: 5, to: 8, message: 'x' },
          { from: 6, to: 9, message: 'y', tone: 'warning' }
        ],
        2
      )
    ).toEqual([
      { text: '{ ' },
      { text: 'a: ', caret: true },
      { text: 'tru', tone: 'danger' },
      { text: ' }' }
    ])
  })

  it('marks an empty range at the end with a space', () => {
    expect(codeInputSegments('{', [{ from: 1, to: 1, message: 'x' }], 1)).toEqual([
      { text: '{' },
      { text: ' ', tone: 'danger', caret: true }
    ])
  })
})
