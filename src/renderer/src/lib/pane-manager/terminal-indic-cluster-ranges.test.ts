import { describe, expect, it } from 'vitest'

import { containsIndicScriptText, findIndicClusterRanges } from './terminal-indic-cluster-ranges'

describe('findIndicClusterRanges', () => {
  it('returns no ranges for ASCII, Latin accents, and Arabic', () => {
    expect(findIndicClusterRanges('ls -la | grep foo && echo done')).toEqual([])
    expect(findIndicClusterRanges('café é مرحبا')).toEqual([])
  })

  it('returns a fresh array on every call so xterm can merge into it safely', () => {
    expect(findIndicClusterRanges('plain')).not.toBe(findIndicClusterRanges('plain'))
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
})

describe('containsIndicScriptText', () => {
  it('detects Brahmic-script code units only', () => {
    expect(containsIndicScriptText('বাংলা')).toBe(true)
    expect(containsIndicScriptText('हिन्दी')).toBe(true)
    expect(containsIndicScriptText('ASCII, 中文, café, مرحبا 😀')).toBe(false)
  })
})
