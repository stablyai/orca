import { describe, expect, it } from 'vitest'
import {
  TERMINAL_INTERRUPT_ETX,
  TERMINAL_INTERRUPT_KITTY_CTRL_C,
  containsTerminalInterruptInput,
  isTerminalInterruptInput,
  terminalInterruptBytes
} from './terminal-interrupt-bytes'

describe('terminalInterruptBytes', () => {
  it('keeps a bare ETX when the kitty keyboard protocol is off', () => {
    expect(terminalInterruptBytes(0)).toBe(TERMINAL_INTERRUPT_ETX)
  })

  it('encodes Ctrl+C when disambiguation or report-all-keys is on', () => {
    expect(terminalInterruptBytes(1)).toBe(TERMINAL_INTERRUPT_KITTY_CTRL_C)
    expect(terminalInterruptBytes(8)).toBe(TERMINAL_INTERRUPT_KITTY_CTRL_C)
    expect(terminalInterruptBytes(31)).toBe('\x1b[99;5u')
  })

  it('keeps a bare ETX when only alternate-key reporting is on', () => {
    expect(terminalInterruptBytes(4)).toBe(TERMINAL_INTERRUPT_ETX)
    expect(terminalInterruptBytes(2 | 4 | 16)).toBe(TERMINAL_INTERRUPT_ETX)
  })
})

describe('isTerminalInterruptInput', () => {
  it('recognizes both ETX and Kitty CSI-u as Ctrl+C', () => {
    expect(isTerminalInterruptInput(TERMINAL_INTERRUPT_ETX)).toBe(true)
    expect(isTerminalInterruptInput(TERMINAL_INTERRUPT_KITTY_CTRL_C)).toBe(true)
  })

  it('does not classify other terminal input as Ctrl+C', () => {
    expect(isTerminalInterruptInput('\x1b')).toBe(false)
    expect(isTerminalInterruptInput('\x1b[99;1u')).toBe(false)
    expect(isTerminalInterruptInput('c')).toBe(false)
  })
})

describe('containsTerminalInterruptInput', () => {
  it('finds either Ctrl+C encoding inside an accepted input chunk', () => {
    expect(containsTerminalInterruptInput(`partial${TERMINAL_INTERRUPT_ETX}`)).toBe(true)
    expect(containsTerminalInterruptInput(`partial${TERMINAL_INTERRUPT_KITTY_CTRL_C}`)).toBe(true)
  })

  it('does not classify ordinary or unrelated Kitty input as Ctrl+C', () => {
    expect(containsTerminalInterruptInput('partial command')).toBe(false)
    expect(containsTerminalInterruptInput('\x1b[99;1u')).toBe(false)
  })
})
