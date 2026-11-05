import { describe, expect, it } from 'vitest'

import { findIndicClusterRanges } from './terminal-indic-cluster-ranges'

describe('findIndicClusterRanges', () => {
  it('returns a fresh array on every call so xterm can merge into it safely', () => {
    findIndicClusterRanges('কি').push([9, 9])
    expect(findIndicClusterRanges('কি')).toEqual([[0, 2]])
  })

  it('joins a conjunct through virama chains', () => {
    expect(findIndicClusterRanges('ক্ষ')).toEqual([[0, 3]])
    expect(findIndicClusterRanges('ন্ত্র')).toEqual([[0, 5]])
  })

  it('joins a Sinhala conjunct written with virama + ZWJ', () => {
    expect(findIndicClusterRanges('ක්\u200Dර')).toEqual([[0, 4]])
  })

  it('does not join across a ZWNJ-blocked conjunct', () => {
    expect(findIndicClusterRanges('ক্\u200Cষ')).toEqual([])
  })

  it('does not let a bare ZWJ open a conjunct', () => {
    expect(findIndicClusterRanges('ক\u200Dখ')).toEqual([])
  })

  it('ends a Malayalam chillu cluster instead of joining the next letter', () => {
    expect(findIndicClusterRanges('ന്\u200Dക')).toEqual([])
  })

  it('leaves Tamil pulli chains per-cell', () => {
    expect(findIndicClusterRanges('க்க்க்')).toEqual([])
  })

  it('still joins a Tamil spacing vowel sign', () => {
    expect(findIndicClusterRanges('கொ')).toEqual([[0, 2]])
  })
})
