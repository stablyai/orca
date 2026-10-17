import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewNoteCountTitle } from './review-note-count-title'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((key: string, fallback: string) => `${key}:${fallback}`)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('reviewNoteCountTitle', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('uses the singular sentence only for exactly one note', () => {
    expect(reviewNoteCountTitle(1)).toBe(
      'auto.components.right.sidebar.SourceControl.noteCountSingular:{{count}} note'
    )
    expect(reviewNoteCountTitle(4)).toBe(
      'auto.components.right.sidebar.SourceControl.noteCountPlural:{{count}} notes'
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.right.sidebar.SourceControl.noteCountSingular',
      '{{count}} note',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.right.sidebar.SourceControl.noteCountPlural',
      '{{count}} notes',
      { count: 4 }
    )
  })
})
