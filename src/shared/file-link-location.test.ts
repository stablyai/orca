import { describe, expect, it } from 'vitest'
import { parseFileLinkLocation, type ParsedFileLinkLocation } from './file-link-location'

function parseWithPreviousPattern(value: string): ParsedFileLinkLocation | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  const pathText = match?.[1]
  if (!pathText) {
    return null
  }
  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }
  return { pathText, line, column }
}

describe('parseFileLinkLocation', () => {
  it('parses agent-style line and column suffixes', () => {
    expect(parseFileLinkLocation('src/main.ts:12:4')).toEqual({
      pathText: 'src/main.ts',
      line: 12,
      column: 4
    })
    expect(parseFileLinkLocation('src/main.ts')).toEqual({
      pathText: 'src/main.ts',
      line: null,
      column: null
    })
  })

  it('preserves Windows drive colons', () => {
    expect(parseFileLinkLocation(String.raw`C:\repo\src\main.ts:12`)).toEqual({
      pathText: String.raw`C:\repo\src\main.ts`,
      line: 12,
      column: null
    })
  })

  it('rejects empty paths and zero locations', () => {
    expect(parseFileLinkLocation('')).toBeNull()
    expect(parseFileLinkLocation('src/main.ts:0')).toBeNull()
    expect(parseFileLinkLocation('src/main.ts:12:0')).toBeNull()
  })

  it('preserves the previous grammar across colon, digit, Unicode, and newline combinations', () => {
    const alphabet = ['a', ':', '0', '1', '2', ' ', '\n', '\r', '\u2028', '\u2029', '😀']
    let checked = 0
    function compare(value: string, remaining: number): void {
      const actual = parseFileLinkLocation(value)
      const expected = parseWithPreviousPattern(value)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        expect(actual, JSON.stringify(value)).toEqual(expected)
      }
      checked += 1
      if (remaining > 0) {
        for (const char of alphabet) {
          compare(value + char, remaining - 1)
        }
      }
    }
    compare('', 5)
    expect(checked).toBe(177_156)
  })

  it.each([
    String.raw`C:\报告 folder\file.ts:0012:0003`,
    '/tmp/a:1:2:3',
    '/tmp/a:1:0',
    '/tmp/a:0:1',
    '/tmp/a:1:bad',
    '/tmp/a:１２:３',
    '/tmp/a:1\n',
    '/tmp/a\r\n',
    `/tmp/${'a '.repeat(1_000)}`,
    `/tmp/file:${'9'.repeat(1_000)}:2`
  ])('preserves the previous result for %s', (value) => {
    expect(parseFileLinkLocation(value)).toEqual(parseWithPreviousPattern(value))
  })
})
