import { describe, expect, it } from 'vitest'
import {
  MAX_RENDERED_DIFF_COMBINED_CHARACTERS,
  MAX_RENDERED_DIFF_LINES_PER_SIDE,
  countLinesEmptyAsZero,
  countLinesEmptyAsZeroUpToLimit,
  countLinesLikeSplit,
  getLargeDiffRenderLimit,
  getLargeDiffRenderLimitFromCounts
} from './large-diff-render-limit'

function buildLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${index}`).join('\n')
}

function buildReproTypeScriptFile(lineCount: number): string {
  const lines: string[] = []
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(`export const largeDiffValue${index} = ${index}`)
  }
  return `${lines.join('\n')}\n`
}

describe('large diff render limit', () => {
  it('counts empty content as zero lines for render safety', () => {
    expect(countLinesEmptyAsZero('')).toBe(0)
    expect(countLinesEmptyAsZero('one')).toBe(1)
    expect(countLinesEmptyAsZero('one\n')).toBe(2)
  })

  it('can stop line counting after a safety threshold', () => {
    const content = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n')

    expect(countLinesEmptyAsZeroUpToLimit(content, 3)).toEqual({ count: 4, exceeded: true })
  })

  it('can preserve split-like semantics for layout estimation', () => {
    expect(countLinesLikeSplit('')).toBe(1)
    expect(countLinesLikeSplit('one')).toBe(1)
    expect(countLinesLikeSplit('one\n')).toBe(2)
  })

  it('allows empty and tiny added or deleted file diffs', () => {
    expect(getLargeDiffRenderLimit({ originalContent: '', modifiedContent: '' }).limited).toBe(
      false
    )
    expect(
      getLargeDiffRenderLimit({
        originalContent: '',
        modifiedContent: 'new file'
      }).limited
    ).toBe(false)
    expect(
      getLargeDiffRenderLimit({
        originalContent: 'deleted file',
        modifiedContent: ''
      }).limited
    ).toBe(false)
  })

  it('keeps the exact per-side line limit renderable', () => {
    const content = buildLines(MAX_RENDERED_DIFF_LINES_PER_SIDE)

    expect(
      getLargeDiffRenderLimit({
        originalContent: content,
        modifiedContent: content
      })
    ).toEqual({
      limited: false,
      lineCounts: {
        original: MAX_RENDERED_DIFF_LINES_PER_SIDE,
        modified: MAX_RENDERED_DIFF_LINES_PER_SIDE
      },
      characterCount: content.length * 2
    })
  })

  it('limits diffs above the per-side line limit', () => {
    const content = buildLines(MAX_RENDERED_DIFF_LINES_PER_SIDE + 1)
    const limit = getLargeDiffRenderLimit({
      originalContent: '',
      modifiedContent: content
    })

    expect(limit.limited).toBe(true)
    if (!limit.limited) {
      throw new Error('expected line-count limit')
    }
    expect(limit.reason).toBe('line-count')
    expect(limit.lineCounts?.modified).toBe(MAX_RENDERED_DIFF_LINES_PER_SIDE + 1)
    expect(limit.lineCountsAreMinimum?.modified).toBe(true)
  })

  it('limits long-line diffs above the combined character ceiling', () => {
    const content = 'a'.repeat(MAX_RENDERED_DIFF_COMBINED_CHARACTERS + 1)
    const limit = getLargeDiffRenderLimit({
      originalContent: '',
      modifiedContent: content
    })

    expect(limit.limited).toBe(true)
    if (!limit.limited) {
      throw new Error('expected character-count limit')
    }
    expect(limit.reason).toBe('character-count')
    expect(limit.lineCounts).toBeNull()
  })

  it('can evaluate live editor limits from cached counts', () => {
    const limit = getLargeDiffRenderLimitFromCounts({
      originalLineCount: 1,
      modifiedLineCount: MAX_RENDERED_DIFF_LINES_PER_SIDE + 1,
      originalCharacterCount: 4,
      modifiedCharacterCount: 42
    })

    expect(limit.limited).toBe(true)
    if (!limit.limited) {
      throw new Error('expected line-count limit')
    }
    expect(limit.reason).toBe('line-count')
    expect(limit.characterCount).toBe(46)
  })

  it('keeps the 60k-line repro below fallback limits', () => {
    const content = buildReproTypeScriptFile(60_000)

    expect(getLargeDiffRenderLimit({ originalContent: '', modifiedContent: content }).limited).toBe(
      false
    )
  })
})
