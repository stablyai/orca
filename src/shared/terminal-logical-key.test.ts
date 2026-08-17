import { describe, expect, it } from 'vitest'
import { bytesFromTerminalLogicalKey, terminalLogicalInputFromBytes } from './terminal-logical-key'

describe('terminalLogicalInputFromBytes', () => {
  it.each([
    ['\x03', 'ctrl+c'],
    ['\x04', 'ctrl+d'],
    ['\x1a', 'ctrl+z'],
    ['\x1c', 'ctrl+\\'],
    ['\x0c', 'ctrl+l'],
    ['\t', 'tab'],
    ['\r', 'enter'],
    ['\x7f', 'backspace'],
    ['\x08', 'backspace'],
    ['\x1b', 'esc']
  ] as const)('maps %j to %s', (bytes, key) => {
    expect(terminalLogicalInputFromBytes(bytes)).toEqual({ kind: 'key', name: key })
  })

  it('maps kitty functional singles to the same names', () => {
    expect(terminalLogicalInputFromBytes('\x1b[27u')).toEqual({ kind: 'key', name: 'esc' })
    expect(terminalLogicalInputFromBytes('\x1b[27;1u')).toEqual({ kind: 'key', name: 'esc' })
    expect(terminalLogicalInputFromBytes('\x1b[9u')).toEqual({ kind: 'key', name: 'tab' })
    expect(terminalLogicalInputFromBytes('\x1b[13u')).toEqual({ kind: 'key', name: 'enter' })
    expect(terminalLogicalInputFromBytes('\x1b[127u')).toEqual({ kind: 'key', name: 'backspace' })
    expect(terminalLogicalInputFromBytes('\x1b[99;5u')).toEqual({ kind: 'key', name: 'ctrl+c' })
    expect(terminalLogicalInputFromBytes('\x1b[100;5u')).toEqual({ kind: 'key', name: 'ctrl+d' })
  })

  it('keeps sequences on the byte path', () => {
    expect(terminalLogicalInputFromBytes('\x1b\x7f')).toEqual({ kind: 'bytes', data: '\x1b\x7f' })
    expect(terminalLogicalInputFromBytes('\x1b[A')).toEqual({ kind: 'bytes', data: '\x1b[A' })
    expect(terminalLogicalInputFromBytes('a')).toEqual({ kind: 'bytes', data: 'a' })
    expect(terminalLogicalInputFromBytes('hello')).toEqual({ kind: 'bytes', data: 'hello' })
    expect(terminalLogicalInputFromBytes('\x1b[27;1;3u')).toEqual({
      kind: 'bytes',
      data: '\x1b[27;1;3u'
    })
  })
})

describe('bytesFromTerminalLogicalKey', () => {
  it('encodes named keys back to the C0 bytes a local PTY writes', () => {
    expect(bytesFromTerminalLogicalKey('ctrl+c')).toBe('\x03')
    expect(bytesFromTerminalLogicalKey('esc')).toBe('\x1b')
    expect(bytesFromTerminalLogicalKey('tab')).toBe('\t')
    expect(bytesFromTerminalLogicalKey('enter')).toBe('\r')
    expect(bytesFromTerminalLogicalKey('unknown')).toBeNull()
  })
})
