import { describe, expect, it } from 'vitest'
import { parseAnsiSegments } from './ipynb-ansi'

describe('parseAnsiSegments', () => {
  it('returns plain text untouched', () => {
    expect(parseAnsiSegments('hello\nworld')).toEqual([{ text: 'hello\nworld' }])
  })

  it('applies and resets 16-color and bold attributes', () => {
    expect(parseAnsiSegments('a\u001b[1;32mb\u001b[0mc\u001b[91md\u001b[39me')).toEqual([
      { text: 'a' },
      { text: 'b', bold: true, fg: 2 },
      { text: 'c' },
      { text: 'd', fg: 9 },
      { text: 'e', fg: undefined }
    ])
  })

  it('resolves 256-color and truecolor sequences', () => {
    expect(parseAnsiSegments('\u001b[38;5;241mx\u001b[38;5;4my\u001b[48;2;1;2;3mz')).toEqual([
      { text: 'x', fg: 'rgb(98, 98, 98)' },
      { text: 'y', fg: 4 },
      { text: 'z', fg: 4, bg: 'rgb(1, 2, 3)' }
    ])
  })

  it('drops non-SGR escape sequences from text', () => {
    expect(parseAnsiSegments('50%\u001b[K done')).toEqual([{ text: '50% done' }])
  })

  it('treats a bare reset as clearing every attribute', () => {
    expect(parseAnsiSegments('\u001b[4;3;31mx\u001b[my')).toEqual([
      { text: 'x', underline: true, italic: true, fg: 1 },
      { text: 'y' }
    ])
  })
})
