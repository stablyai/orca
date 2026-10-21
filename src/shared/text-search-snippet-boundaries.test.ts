import { describe, expect, it } from 'vitest'
import {
  createAccumulator,
  ingestGitGrepLine,
  ingestRgJsonLine,
  MAX_LINE_CONTENT_LENGTH
} from './text-search'

describe('search snippet character boundaries', () => {
  it.each([
    ['start', '😀'.repeat(300), 'x', 'a'.repeat(600)],
    ['end', 'a'.repeat(600), 'xx', '😀'.repeat(300)],
    ['both', '😀'.repeat(300), 'xx', '😀'.repeat(300)],
    ['long match', 'a'.repeat(10), `x${'😀'.repeat(300)}`, 'b'.repeat(600)],
    ['zero width', '😀'.repeat(300), '', '😀'.repeat(300)],
    ['zero width at EOF', `${'😀'.repeat(301)}x`, '', ''],
    ['first character', '', '😀', 'a'.repeat(600)],
    ['last character', 'a'.repeat(600), '😀', ''],
    ['short line', '😀', 'x', '😀']
  ])(
    'keeps the %s boundary whole and retains navigation coordinates',
    (_name, prefix, needle, suffix) => {
      const text = prefix + needle + suffix
      const accumulator = createAccumulator()
      ingestRgJsonLine(
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: 'unicode.txt' },
            lines: { text: `${text}\n` },
            line_number: 7,
            submatches: [
              { start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + needle) }
            ]
          }
        }),
        '/root',
        accumulator,
        2000
      )
      const match = [...accumulator.fileMap.values()][0].matches[0]
      expect(match).toMatchObject({
        line: 7,
        column: prefix.length + 1,
        matchLength: needle.length
      })
      expect(match.lineContent.isWellFormed()).toBe(true)
      expect(match.lineContent.length).toBeLessThanOrEqual(MAX_LINE_CONTENT_LENGTH + 2)
      const start = (match.displayColumn ?? match.column) - 1
      const length = match.displayMatchLength ?? match.matchLength
      const highlighted = match.lineContent.slice(start, start + length)
      expect(highlighted.isWellFormed()).toBe(true)
      expect(needle.startsWith(highlighted)).toBe(true)
      if (needle.length <= MAX_LINE_CONTENT_LENGTH) {
        expect(highlighted).toBe(needle)
      } else {
        expect(length).toBe(MAX_LINE_CONTENT_LENGTH - 1)
        expect(highlighted).toBe(`x${'😀'.repeat(249)}`)
      }
    }
  )

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
