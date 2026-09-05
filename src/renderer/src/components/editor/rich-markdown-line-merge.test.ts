import { describe, expect, it } from 'vitest'
import { mergeMarkdownSourceByLines } from './rich-markdown-line-merge'

describe('mergeMarkdownSourceByLines', () => {
  it('keeps untouched original bytes and applies the user edit', () => {
    // base = canonical(original); the user appended to the last line only.
    const original = 'a > b\n_c_\nkeep&this\nlast\n'
    const base = 'a &gt; b\n*c*\nkeep&amp;this\nlast\n'
    const edited = 'a &gt; b\n*c*\nkeep&amp;this\nlast EDITED\n'
    expect(mergeMarkdownSourceByLines(original, base, edited)).toBe(
      'a > b\n_c_\nkeep&this\nlast EDITED\n'
    )
  })

  it('returns the original verbatim when the user made no edit', () => {
    const original = 'a > b\n_c_\n'
    const base = 'a &gt; b\n*c*\n'
    expect(mergeMarkdownSourceByLines(original, base, base)).toBe(original)
  })

  it('applies a pure insertion without recanonicalizing surrounding lines', () => {
    const original = 'x > y\nz\n'
    const base = 'x &gt; y\nz\n'
    const edited = 'x &gt; y\nNEW LINE\nz\n'
    expect(mergeMarkdownSourceByLines(original, base, edited)).toBe('x > y\nNEW LINE\nz\n')
  })

  it('applies a deletion while preserving non-adjacent non-canonical lines', () => {
    const original = 'top > line\nanchor\nmid&mid\nanchor2\nz_end\n'
    const base = 'top &gt; line\nanchor\nmid&amp;mid\nanchor2\nz_end\n'
    const edited = 'top &gt; line\nanchor\nanchor2\nz_end\n'
    expect(mergeMarkdownSourceByLines(original, base, edited)).toBe(
      'top > line\nanchor\nanchor2\nz_end\n'
    )
  })

  it('bails to null when both sides collapse to a whole-document rewrite', () => {
    // Single line that differs on every side: no stable anchor to preserve.
    expect(mergeMarkdownSourceByLines('_a_', '*a*', '*a* b')).toBeNull()
  })

  it('matches a brute-force oracle across randomized edits (fuzz)', () => {
    let seed = 987654321
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let trial = 0; trial < 500; trial += 1) {
      const n = 4 + Math.floor(rand() * 8)
      const baseLines = Array.from({ length: n }, (_, i) => `L${i}`)
      // Edit a contiguous window whose adjacent anchor lines stay base-identical so
      // ours (style-only) and theirs (edit) regions never abut-merge into a conflict.
      const lo = 1 + Math.floor(rand() * (n - 2))
      const hi = lo + Math.floor(rand() * (n - lo - 1))
      const oursLines = baseLines.map((l, i) =>
        i === lo - 1 || i === hi ? l : rand() < 0.6 ? `${l}~` : l
      )
      const replacement =
        rand() < 0.5
          ? []
          : Array.from({ length: 1 + Math.floor(rand() * 2) }, (_, k) => `E${lo}_${k}`)
      const theirsLines = [...baseLines.slice(0, lo), ...replacement, ...baseLines.slice(hi)]
      const oracle = [...oursLines.slice(0, lo), ...replacement, ...oursLines.slice(hi)]

      const join = (lines: string[]): string => lines.map((l) => `${l}\n`).join('')
      const merged = mergeMarkdownSourceByLines(join(oursLines), join(baseLines), join(theirsLines))
      expect({ trial, merged }).toEqual({ trial, merged: join(oracle) })
    }
  })
})
