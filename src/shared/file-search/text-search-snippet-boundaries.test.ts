import { describe, expect, it } from 'vitest'
import { createAccumulator, ingestGitGrepLine, ingestRgJsonLine } from './text-search'

describe('search snippet character boundaries', () => {
  it('uses the same character-safe context for the remote git fallback', () => {
    const prefix = '😀'.repeat(300)
    const accumulator = createAccumulator()
    ingestGitGrepLine(`unicode.txt\x001\x00${prefix}xx${prefix}`, '/root', /xx/g, accumulator, 2000)
    const match = [...accumulator.fileMap.values()][0].matches[0]
    expect(match.lineContent.isWellFormed()).toBe(true)
    expect(match.column).toBe(601)
    const start = (match.displayColumn ?? match.column) - 1
    expect(
      match.lineContent.slice(start, start + (match.displayMatchLength ?? match.matchLength))
    ).toBe('xx')
  })

  it('never returns a negative display length for a zero-width range after the line terminator', () => {
    const text = `${'x'.repeat(600)}\n`
    const accumulator = createAccumulator()
    ingestRgJsonLine(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'line.txt' },
          lines: { text },
          line_number: 1,
          submatches: [{ start: text.length, end: text.length }]
        }
      }),
      '/root',
      accumulator,
      2000
    )
    const match = [...accumulator.fileMap.values()][0].matches[0]
    expect(match.matchLength).toBe(0)
    expect(match.displayMatchLength).toBe(0)
  })

  it('excludes truncation markers when a fallback regex begins inside a surrogate pair', () => {
    const accumulator = createAccumulator()
    ingestGitGrepLine(
      `unicode.txt\x001\x00${'😀'.repeat(600)}`,
      '/root',
      /.{501}/g,
      accumulator,
      2000
    )
    const match = [...accumulator.fileMap.values()][0].matches[1]
    expect(match.column).toBe(502)
    expect(match.matchLength).toBe(501)
    expect(match.displayColumn).toBe(2)
    expect(match.displayMatchLength).toBe(498)
    expect(match.lineContent).toBe(`…${'😀'.repeat(249)}…`)
    expect(match.lineContent.slice(1, 499)).toBe('😀'.repeat(249))
  })
})
