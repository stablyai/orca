import { describe, expect, it } from 'vitest'
import { startOfLastLines, startOfLastNonBlankLines } from './terminal-wait-tail-window'

describe('startOfLastNonBlankLines', () => {
  it('returns 0 for a tail that begins with a newline', () => {
    // Regression: `lastIndexOf('\n', -1)` clamps its position argument up to 0, so a leading
    // newline made the walk answer lineStart=1 with lineEnd=0 forever. Every caller runs on
    // the main process's PTY data path, so the spin was a hard hang, not a slow scan. Reached
    // only when the tail also holds fewer than `count` non-blank lines, which is the shape of
    // a small startup dialog on an otherwise empty screen.
    expect(startOfLastNonBlankLines('\ndo you trust this folder?', 12)).toBe(0)
    expect(startOfLastNonBlankLines('\n', 12)).toBe(0)
    expect(startOfLastNonBlankLines('\n\n\n  \n', 4)).toBe(0)
  })

  it('still windows a tail with interior blank rows', () => {
    const tail = 'one\n\ntwo\n\nthree'
    expect(startOfLastNonBlankLines(tail, 1)).toBe(tail.indexOf('three'))
    expect(startOfLastNonBlankLines(tail, 2)).toBe(tail.indexOf('two'))
    expect(startOfLastNonBlankLines(tail, 9)).toBe(0)
  })

  it('counts blank rows in the raw line window', () => {
    const tail = 'one\n\ntwo'
    expect(startOfLastLines(tail, 2)).toBe(tail.indexOf('\ntwo') - 0)
    expect(startOfLastLines(tail, 9)).toBe(0)
  })
})
