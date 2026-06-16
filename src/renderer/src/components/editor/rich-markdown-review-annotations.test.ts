import { describe, expect, it } from 'vitest'
import {
  getRichMarkdownAnnotationButtonLeft,
  getRichMarkdownAnnotationButtonTop
} from './rich-markdown-review-annotations'

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
