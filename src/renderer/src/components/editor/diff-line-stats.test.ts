import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeLineStats } from './diff-line-stats'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('computeLineStats', () => {
  it('keeps existing added, deleted, and modified line count behavior', () => {
    expect(computeLineStats('', 'a\nb', 'added')).toEqual({ added: 2, removed: 0 })
    expect(computeLineStats('a\nb\n', '', 'deleted')).toEqual({ added: 0, removed: 3 })
    expect(computeLineStats('a\nb\nc', 'a\nc\nd', 'modified')).toEqual({
      added: 1,
      removed: 1
    })
  })

  it('counts newline-heavy added and deleted pasted content without splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = '\n'.repeat(100_000)

    expect(computeLineStats('', content, 'added')).toEqual({ added: 100_001, removed: 0 })
    expect(computeLineStats(content, '', 'deleted')).toEqual({ added: 0, removed: 100_001 })

    expect(split).not.toHaveBeenCalled()
  })

  it('compares modified files without splitting either side into line arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(computeLineStats('same\nold\nkept', 'same\nnew\nkept', 'modified')).toEqual({
      added: 1,
      removed: 1
    })

    expect(split).not.toHaveBeenCalled()
  })

  it('keeps the existing large modified-file guard before building multisets', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(computeLineStats('x'.repeat(250_001), 'y'.repeat(250_000), 'modified')).toBeNull()

    expect(split).not.toHaveBeenCalled()
  })
})
