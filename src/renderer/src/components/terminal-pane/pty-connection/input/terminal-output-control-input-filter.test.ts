import { describe, expect, it } from 'vitest'
import { TerminalOutputControlInputFilter } from './terminal-output-control-input-filter'

describe('TerminalOutputControlInputFilter', () => {
  it('drops mode restore controls without dropping a terminal query reply', () => {
    const filter = new TerminalOutputControlInputFilter()

    expect(filter.filter('\x1b[?1002h\x1b[>4;2m\x1b[?1;2c')).toBe('\x1b[?1;2c')
  })

  it('drops a split mode restore control', () => {
    const filter = new TerminalOutputControlInputFilter()

    expect(filter.filter('\x1b[?100')).toBe('')
    expect(filter.filter('2h')).toBe('')
  })

  it('passes a lone escape through so unclassified Escape keypresses still reach the PTY', () => {
    const filter = new TerminalOutputControlInputFilter()

    expect(filter.filter('\x1b')).toBe('\x1b')
  })

  it('keeps ordinary non-user terminal data intact', () => {
    const filter = new TerminalOutputControlInputFilter()

    expect(filter.filter('typed text\x1b[A')).toBe('typed text\x1b[A')
  })
})
