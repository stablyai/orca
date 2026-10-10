import { afterEach, describe, expect, it, vi } from 'vitest'
import { forEachLine } from './text-line-offsets'

type LineOffsets = readonly [number, number, number]

function collect(content: string): LineOffsets[] {
  const lines: LineOffsets[] = []
  forEachLine(content, (start, end, number) => {
    lines.push([start, end, number])
  })
  return lines
}

function splitOffsets(content: string): LineOffsets[] {
  let offset = 0
  return content.split('\n').map((line, index) => {
    const start = offset
    offset += line.length + 1
    return [start, start + line.length - (line.endsWith('\r') ? 1 : 0), index + 1]
  })
}

afterEach(() => vi.restoreAllMocks())

describe('text line offsets', () => {
  it.each([
    '',
    'plain',
    '\n',
    '\n\n',
    'one\ntwo\n',
    'one\r\ntwo\r\n',
    '\r\n\n\r\n',
    'one\rtwo\r',
    'one\rtwo\r\nthree\r',
    '😀\r\n日本語\n\ud800\udc00\n\ud800\n\udc00',
    '\ufefffirst\u2028same line\u2029\nlast'
  ])('preserves exact UTF16 offsets and LF-only boundaries for %j', (content) => {
    expect(collect(content)).toEqual(splitOffsets(content))
  })

  it('keeps offsets across mixed empty lines and split surrogate pairs', () => {
    const pieces = ['', '\n', '\r', '\r\n', 'abc', '😀', '\ud800', '\udc00']
    for (const first of pieces) {
      for (const second of pieces) {
        for (const third of pieces) {
          const content = first + second + third
          expect(collect(content)).toEqual(splitOffsets(content))
        }
      }
    }
  })

  it('stops before visiting further lines when requested', () => {
    const visited: LineOffsets[] = []
    forEachLine('one\r\ntwo\nthree', (start, end, number) => {
      visited.push([start, end, number])
      return number !== 2
    })
    expect(visited).toEqual([
      [0, 3, 1],
      [5, 8, 2]
    ])
  })

  it('does not inspect every code unit in long nonmarker lines', () => {
    const content = `${'x'.repeat(512 * 1024)}\r\n${'😀'.repeat(80 * 1024)}\n`
    const expected = splitOffsets(content)
    const inspect = vi.spyOn(String.prototype, 'charCodeAt')
    const actual = collect(content)
    const inspected = inspect.mock.calls.length
    inspect.mockRestore()

    expect(actual).toEqual(expected)
    expect(inspected).toBeLessThanOrEqual(expected.length)
  })
})
