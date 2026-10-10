import { describe, expect, it } from 'vitest'
import {
  SYNCHRONIZED_OUTPUT_END_SEQUENCE,
  SYNCHRONIZED_OUTPUT_START_SEQUENCE
} from './terminal-synchronized-output-scan'
import {
  synchronizeInPlaceRedrawChunk,
  type InPlaceRedrawTerminal
} from './terminal-inplace-redraw-sync'

const OPEN = SYNCHRONIZED_OUTPUT_START_SEQUENCE
const CLOSE = SYNCHRONIZED_OUTPUT_END_SEQUENCE
const REDRAW = `${'\x1b[2K\x1b[1A'.repeat(9)}Grok\r\nThinking\r\n`
const owner = (): InPlaceRedrawTerminal => ({ write() {} })

describe('synchronizeInPlaceRedrawChunk', () => {
  it('wraps a cursor-up redraw so xterm paints the settled frame once', () => {
    const terminal = owner()
    expect(synchronizeInPlaceRedrawChunk(terminal, REDRAW)).toBe(`${OPEN}${REDRAW}${CLOSE}`)
  })

  it('leaves ordinary output and a short cursor move alone', () => {
    const terminal = owner()
    expect(synchronizeInPlaceRedrawChunk(terminal, 'hello\r\n')).toBe('hello\r\n')
    expect(synchronizeInPlaceRedrawChunk(terminal, '\x1b[1A\x1b[1Aone line\r\n')).toBe(
      '\x1b[1A\x1b[1Aone line\r\n'
    )
  })

  it('does not close a synchronized frame the application already opened', () => {
    const terminal = owner()
    const opened = synchronizeInPlaceRedrawChunk(terminal, `${OPEN}partial`)
    expect(opened).toBe(`${OPEN}partial`)
    const continued = synchronizeInPlaceRedrawChunk(terminal, REDRAW)
    expect(continued).toBe(REDRAW)
    const closed = synchronizeInPlaceRedrawChunk(terminal, `done${CLOSE}`)
    expect(closed).toBe(`done${CLOSE}`)
    expect(synchronizeInPlaceRedrawChunk(terminal, REDRAW)).toBe(`${OPEN}${REDRAW}${CLOSE}`)
  })

  it('does not wrap a redraw that already carries its own synchronized frame', () => {
    const terminal = owner()
    const framed = `${OPEN}${REDRAW}${CLOSE}`
    expect(synchronizeInPlaceRedrawChunk(terminal, framed)).toBe(framed)
  })

  it('wraps exactly three one-row cursor ups and ignores a shorter run', () => {
    const terminal = owner()
    const three = '\x1b[1A\x1b[1A\x1b[1Astatus'
    const two = '\x1b[1A\x1b[1Astatus'
    expect(synchronizeInPlaceRedrawChunk(terminal, three)).toBe(`${OPEN}${three}${CLOSE}`)
    expect(synchronizeInPlaceRedrawChunk(owner(), two)).toBe(two)
  })

  it('does not treat a multi-row cursor-up as three one-row moves', () => {
    const terminal = owner()
    const multi = '\x1b[11A\x1b[11A\x1b[11Astatus'
    expect(synchronizeInPlaceRedrawChunk(terminal, multi)).toBe(multi)
  })

  it('keeps an application frame closed when the open marker arrives split', () => {
    const terminal = owner()
    const head = OPEN.slice(0, -1)
    expect(synchronizeInPlaceRedrawChunk(terminal, head)).toBe(head)
    const continued = `${OPEN.slice(-1)}${REDRAW}`
    expect(synchronizeInPlaceRedrawChunk(terminal, continued)).toBe(continued)
    expect(synchronizeInPlaceRedrawChunk(terminal, CLOSE)).toBe(CLOSE)
    expect(synchronizeInPlaceRedrawChunk(terminal, REDRAW)).toBe(`${OPEN}${REDRAW}${CLOSE}`)
  })

  it('does not let one terminal open frame suppress another terminal redraw', () => {
    const blocked = owner()
    const other = owner()
    expect(synchronizeInPlaceRedrawChunk(blocked, `${OPEN}partial`)).toBe(`${OPEN}partial`)
    expect(synchronizeInPlaceRedrawChunk(other, REDRAW)).toBe(`${OPEN}${REDRAW}${CLOSE}`)
    expect(synchronizeInPlaceRedrawChunk(blocked, REDRAW)).toBe(REDRAW)
  })
})
