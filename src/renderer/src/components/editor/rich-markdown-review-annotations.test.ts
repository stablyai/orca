import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  countRichMarkdownReviewMarkdownLines,
  getRichMarkdownAnnotationButtonLeft,
  getRichMarkdownAnnotationButtonTop
} from './rich-markdown-review-annotations'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('countRichMarkdownReviewMarkdownLines', () => {
  it('counts LF, CRLF, and CR line endings exactly', () => {
    expect(countRichMarkdownReviewMarkdownLines('')).toBe(1)
    expect(countRichMarkdownReviewMarkdownLines('one')).toBe(1)
    expect(countRichMarkdownReviewMarkdownLines('one\ntwo')).toBe(2)
    expect(countRichMarkdownReviewMarkdownLines('one\r\ntwo\r\nthree')).toBe(3)
    expect(countRichMarkdownReviewMarkdownLines('one\rtwo')).toBe(2)
  })

  it('counts large pasted markdown blocks without splitting into line arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const text = 'line\r\n'.repeat(100_000)

    expect(countRichMarkdownReviewMarkdownLines(text)).toBe(100_001)

    expect(split).not.toHaveBeenCalled()
  })
})

describe('getRichMarkdownAnnotationButtonTop', () => {
  it('keeps the add-note button below short visible selections', () => {
    expect(getRichMarkdownAnnotationButtonTop(120, 500)).toBe(128)
  })

  it('clamps the add-note button inside the visible editor shell for long selections', () => {
    expect(getRichMarkdownAnnotationButtonTop(760, 500)).toBe(468)
  })
})

describe('getRichMarkdownAnnotationButtonLeft', () => {
  it('keeps the add-note button near the right edge when there is room', () => {
    expect(getRichMarkdownAnnotationButtonLeft(700)).toBe(658)
  })

  it('clamps the add-note button inside narrow editor shells', () => {
    expect(getRichMarkdownAnnotationButtonLeft(72)).toBe(40)
  })
})
