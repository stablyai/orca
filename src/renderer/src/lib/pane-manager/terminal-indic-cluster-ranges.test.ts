import { describe, expect, it } from 'vitest'

import { findIndicClusterRanges } from './terminal-indic-cluster-ranges'

describe('findIndicClusterRanges', () => {
  it('returns no ranges for ASCII, Latin accents, and Arabic', () => {
    expect(findIndicClusterRanges('ls -la | grep foo && echo done')).toEqual([])
    expect(findIndicClusterRanges('café é مرحبا')).toEqual([])
  })

  it('returns a fresh array on every call so xterm can merge into it safely', () => {
    findIndicClusterRanges('কি').push([9, 9])
    expect(findIndicClusterRanges('কি')).toEqual([[0, 2]])
  })

  it('joins a base letter with its spacing vowel sign', () => {
    expect(findIndicClusterRanges('কি')).toEqual([[0, 2]])
    expect(findIndicClusterRanges('কৌ')).toEqual([[0, 2]])
  })

  it('joins each cluster of a word separately', () => {
    // আ + মি + দে + খি: lone letters stay per-cell, only multi-cell clusters join.
    expect(findIndicClusterRanges('আমি দেখি')).toEqual([
      [1, 3],
      [4, 6],
      [6, 8]
    ])
  })

  it('joins a conjunct through virama chains', () => {
    expect(findIndicClusterRanges('ক্ষ')).toEqual([[0, 3]])
    expect(findIndicClusterRanges('ন্ত্র')).toEqual([[0, 5]])
  })

  it('joins a conjunct together with a trailing vowel sign', () => {
    // অ + ন্যে + র
    expect(findIndicClusterRanges('অন্যের')).toEqual([[1, 5]])
  })

  it('joins Devanagari clusters', () => {
    expect(findIndicClusterRanges('हिन्दी')).toEqual([
      [0, 2],
      [2, 6]
    ])
  })

  it('leaves nonspacing-only clusters in their single base cell', () => {
    expect(findIndicClusterRanges('কু')).toEqual([])
    expect(findIndicClusterRanges('চাঁদ')).toEqual([[0, 3]])
  })

  it('does not join a virama with nothing after it', () => {
    expect(findIndicClusterRanges('ক্')).toEqual([])
  })

  it('keeps ASCII and box-drawing neighbours out of the ranges', () => {
    expect(findIndicClusterRanges('│ কি abc │')).toEqual([[2, 4]])
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
