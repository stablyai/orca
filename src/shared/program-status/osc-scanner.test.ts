import { describe, expect, it } from 'vitest'
import { createProgramStatusOscScanner } from './osc-scanner'

describe('createProgramStatusOscScanner', () => {
  it('stays on the fast path for ordinary output', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('\x1b[31mred\x1b[0m plain\r\n')).toEqual([])
  })

  it('reads BEL- and ST-terminated reports with their end offsets', () => {
    const scan = createProgramStatusOscScanner()
    const data = 'a\x1b]7501;state=working\x07b\x1b]7501;state=done\x1b\\c'
    expect(scan(data)).toEqual([
      { type: 'report', report: { id: null, state: 'working' }, offset: data.indexOf('b') },
      { type: 'report', report: { id: null, state: 'done' }, offset: data.indexOf('c') }
    ])
  })

  it('reassembles a report and its introducer split across chunks', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('out\x1b]75')).toEqual([])
    expect(scan('01;state=blo')).toEqual([])
    expect(scan('cked:kind=question\x1b')).toEqual([])
    expect(scan('\\tail')).toEqual([
      { type: 'report', report: { id: null, state: 'blocked', kind: 'question' }, offset: 1 }
    ])
  })

  it('reports queries, shell prompt starts and full resets in byte order', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('\x1b]7501;?\x1b\\\x1b[c\x1b]133;A\x07\x1bc').map((event) => event.type)).toEqual([
      'query',
      'prompt-start',
      'full-reset'
    ])
  })

  it('carries a split prompt marker', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('$ \x1b]13')).toEqual([])
    expect(scan('3;A\x07')).toEqual([{ type: 'prompt-start', offset: 4 }])
  })

  it('reads a prompt start only once its whole frame arrives', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('$ \x1b]133;A')).toEqual([])
    expect(scan(';cl=m\x1b')).toEqual([])
    expect(scan('\\')).toEqual([{ type: 'prompt-start', offset: 1 }])
    expect(scan('\x1b]133;AB\x07\x1b]133;B\x07')).toEqual([])
  })

  it('drops frames CAN/SUB cancel, and ends one at the next sequence as xterm does', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('\x1b]133;A;x\x18y\x07\x1b]7501;state=working\x1ax\x07')).toEqual([])
    expect(scan('\x1b]133;A\x1b]7501;state=working\x1b[0m')).toMatchObject([
      { type: 'prompt-start' },
      { type: 'report', report: { state: 'working' } }
    ])
  })

  it('discards a frame past the sequence cap and keeps scanning', () => {
    const scan = createProgramStatusOscScanner()
    const oversized = `\x1b]7501;state=working:junk=${'x'.repeat(5000)}\x07`
    expect(scan(`${oversized}\x1b]7501;state=idle\x07`)).toMatchObject([
      { type: 'report', report: { state: 'idle' } }
    ])
  })

  it('drops an unterminated frame once it outgrows the cap', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan(`\x1b]7501;state=working:junk=${'x'.repeat(5000)}`)).toEqual([])
    expect(scan('\x07\x1b]7501;state=done\x07')).toMatchObject([{ report: { state: 'done' } }])
  })
})
