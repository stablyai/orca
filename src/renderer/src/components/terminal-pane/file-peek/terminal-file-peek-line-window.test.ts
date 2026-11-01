import { describe, expect, it } from 'vitest'
import { TerminalFilePeekLineWindow } from './terminal-file-peek-line-window'

const encode = (source: string) => new TextEncoder().encode(source)

describe('TerminalFilePeekLineWindow', () => {
  it.each([
    { target: 3, total: 60, first: 1, last: 'line 20' },
    { target: 25, total: 60, first: 15, last: 'line 34' },
    { target: 27, total: 30, first: 11, last: 'line 30' }
  ])('centers line $target and backfills near EOF', ({ target, total, first, last }) => {
    const window = new TerminalFilePeekLineWindow(target)
    window.push(encode(Array.from({ length: total }, (_, index) => `line ${index + 1}`).join('\n')))
    const result = window.finish(true)
    expect(result.kind).toBe('text')
    if (result.kind !== 'text') {
      throw new Error('Expected text')
    }
    expect(result.firstLineNumber).toBe(first)
    expect(result.targetLine).toBe(target)
    expect(result.lines).toHaveLength(20)
    expect(result.lines.at(-1)).toBe(last)
    expect(result.lines).toContain(`line ${target}`)
  })

  it('rejects a target beyond EOF', () => {
    const window = new TerminalFilePeekLineWindow(4)
    window.push(encode('one\ntwo\nthree'))
    expect(window.finish(true)).toEqual({ kind: 'notice', reason: 'line-out-of-range' })
  })

  it('rejects a target not reached in the 1 MiB budget', () => {
    const window = new TerminalFilePeekLineWindow(2)
    const chunk = encode('x'.repeat(64 * 1024))
    for (let index = 0; index < 16; index += 1) {
      window.push(chunk)
    }
    expect(window.complete).toBe(false)
    expect(window.finish(false)).toEqual({ kind: 'notice', reason: 'line-out-of-range' })
  })

  it('decodes split UTF-8 and CRLF across chunk boundaries', () => {
    const window = new TerminalFilePeekLineWindow(2)
    for (const byte of encode('café\r\n🦀 code\r\nlast')) {
      window.push(new Uint8Array([byte]))
    }
    expect(window.finish(true)).toEqual({
      kind: 'text',
      firstLineNumber: 1,
      targetLine: 2,
      lines: ['café', '🦀 code', 'last'],
      truncatedLines: false
    })
  })

  it('truncates only lines longer than 240 characters without splitting Unicode', () => {
    const window = new TerminalFilePeekLineWindow(null)
    window.push(encode(`${'🦀'.repeat(241)}\r`))
    window.push(encode(`\n${'x'.repeat(240)}`))
    expect(window.finish(true)).toEqual({
      kind: 'text',
      firstLineNumber: 1,
      targetLine: null,
      lines: ['🦀'.repeat(240), 'x'.repeat(240)],
      truncatedLines: true
    })
    const exact = new TerminalFilePeekLineWindow(null)
    exact.push(encode('x'.repeat(240)))
    expect(exact.finish(true)).toMatchObject({ truncatedLines: false })
  })

  it('does not flush an incomplete UTF-8 sequence at the read budget', () => {
    const window = new TerminalFilePeekLineWindow(1)
    window.push(new Uint8Array([65, 0xf0, 0x9f]))
    expect(window.finish(false)).toMatchObject({ kind: 'text', lines: ['A'] })
  })

  it('keeps empty files and the empty line after a final newline addressable', () => {
    expect(new TerminalFilePeekLineWindow(1).finish(true)).toMatchObject({ lines: [''] })
    const window = new TerminalFilePeekLineWindow(2)
    window.push(encode('one\n'))
    expect(window.finish(true)).toMatchObject({ targetLine: 2, lines: ['one', ''] })
  })

  it('stops at the first 20 lines when the link has no line', () => {
    const window = new TerminalFilePeekLineWindow(null)
    window.push(encode(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')))
    expect(window.complete).toBe(true)
    expect(window.finish(false)).toEqual({
      kind: 'text',
      firstLineNumber: 1,
      targetLine: null,
      lines: [
        'line 1',
        'line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
        'line 10',
        'line 11',
        'line 12',
        'line 13',
        'line 14',
        'line 15',
        'line 16',
        'line 17',
        'line 18',
        'line 19',
        'line 20'
      ],
      truncatedLines: false
    })
  })
})
