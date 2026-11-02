import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { writeToTerminal } from '../../../../shared/terminal-restore-parity-fixture'
import { TerminalResumeEscapeGap } from './terminal-resume-escape-gap'

function terminal(): Terminal {
  return new Terminal({ cols: 20, rows: 2, allowProposedApi: true })
}

function row(t: Terminal): string {
  return t.buffer.active.getLine(0)?.translateToString(true) ?? ''
}

function chunk(
  data: string,
  startSeq: number | undefined,
  opts: { gapEscapeState?: string; mappable?: boolean } = {}
) {
  return {
    data,
    startSeq,
    mappable: opts.mappable ?? true,
    gapEscapeState: opts.gapEscapeState
  }
}

describe('TerminalResumeEscapeGap', () => {
  it('skips the continuation of an escape main dropped before a gap (stray "2C")', async () => {
    const t = terminal()
    const gap = new TerminalResumeEscapeGap()
    await writeToTerminal(t, '> ')
    const data = gap.admit(chunk('2Cx', 40, { gapEscapeState: '\x1b[' }), {
      paintedSeq: 2,
      parserEscape: ''
    })
    await writeToTerminal(t, data)
    expect(row(t)).toBe('> x')
  })

  it('lets a replayed tail complete when the chunk resumes exactly at the replay seq', async () => {
    const t = terminal()
    const gap = new TerminalResumeEscapeGap()
    await writeToTerminal(t, '>\x1b[')
    const data = gap.admit(chunk('2Cx', 40, { gapEscapeState: '\x1b[' }), {
      paintedSeq: 40,
      parserEscape: '\x1b['
    })
    await writeToTerminal(t, data)
    expect(row(t)).toBe('>  x')
  })

  it('skips the continuation of an escape the renderer aborted with its own reset', async () => {
    const t = terminal()
    const gap = new TerminalResumeEscapeGap()
    await writeToTerminal(t, '>\x1b[')
    gap.noteGroundingWrite('\x1b[')
    gap.noteGroundingWrite('')
    await writeToTerminal(t, '\x18\x1b[0m')
    const data = gap.admit(chunk('2Cx', 40), { paintedSeq: 40, parserEscape: '' })
    await writeToTerminal(t, data)
    expect(row(t)).toBe('>x')
  })

  it('grounds a stale pre-gap escape after skipping the labeled continuation', async () => {
    const t = terminal()
    const gap = new TerminalResumeEscapeGap()
    await writeToTerminal(t, '>\x1b]0;stale')
    const data = gap.admit(chunk('2Cx', 40, { gapEscapeState: '\x1b[' }), {
      paintedSeq: 10,
      parserEscape: '\x1b]'
    })
    await writeToTerminal(t, data)
    expect(row(t)).toBe('>x')
  })

  it('carries an unfinished skip into the next contiguous chunk only', async () => {
    const gap = new TerminalResumeEscapeGap()
    expect(
      gap.admit(chunk('0;ti', 40, { gapEscapeState: '\x1b]' }), {
        paintedSeq: 10,
        parserEscape: ''
      })
    ).toBe('')
    expect(gap.admit(chunk('tle\x07ok', 44), { paintedSeq: 44, parserEscape: '' })).toBe('ok')
    expect(gap.admit(chunk('more', 50), { paintedSeq: 50, parserEscape: '' })).toBe('more')
  })

  it('never deletes bytes when ordering or byte mapping is unproven', () => {
    const gap = new TerminalResumeEscapeGap()
    const labeled = { gapEscapeState: '\x1b[' }
    expect(gap.admit(chunk('2Cx', undefined, labeled), { paintedSeq: 2, parserEscape: '' })).toBe(
      '2Cx'
    )
    expect(gap.admit(chunk('2Cx', 40, labeled), { paintedSeq: null, parserEscape: '' })).toBe('2Cx')
    expect(
      gap.admit(chunk('2Cx', 40, { ...labeled, mappable: false }), {
        paintedSeq: 2,
        parserEscape: ''
      })
    ).toBe('2Cx')
  })

  it('lets a parser already holding the labeled prefix complete the escape', async () => {
    const t = terminal()
    const gap = new TerminalResumeEscapeGap()
    await writeToTerminal(t, '\x1b[?1049')
    const data = gap.admit(chunk('hX', 40, { gapEscapeState: '\x1b[' }), {
      paintedSeq: 2,
      parserEscape: '\x1b['
    })
    await writeToTerminal(t, data)
    expect(t.buffer.active.type).toBe('alternate')
  })

  it('honors the label after our reset even when main transformed the chunk', () => {
    const gap = new TerminalResumeEscapeGap()
    gap.noteGroundingWrite('')
    expect(
      gap.admit(chunk('2Cx', 40, { gapEscapeState: '\x1b[', mappable: false }), {
        paintedSeq: null,
        parserEscape: ''
      })
    ).toBe('x')
  })

  it('skips a labeled continuation after a reset even without seq metering', () => {
    const gap = new TerminalResumeEscapeGap()
    gap.noteGroundingWrite('')
    expect(
      gap.admit(chunk('2Cx', undefined, { gapEscapeState: '\x1b[' }), {
        paintedSeq: null,
        parserEscape: ''
      })
    ).toBe('x')
  })

  it('keeps an aborted escape away from chunks without proven contiguity', () => {
    const gap = new TerminalResumeEscapeGap()
    gap.noteGroundingWrite('\x1b[')
    expect(gap.admit(chunk('hello', undefined), { paintedSeq: null, parserEscape: '' })).toBe(
      'hello'
    )
  })

  it('forgets an aborted escape once a replay repaints the parser state', () => {
    const gap = new TerminalResumeEscapeGap()
    gap.noteGroundingWrite('\x1b[')
    gap.reset()
    expect(gap.admit(chunk('2Cx', 40), { paintedSeq: 40, parserEscape: '' })).toBe('2Cx')
  })
})
