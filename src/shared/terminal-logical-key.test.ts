import { describe, expect, it } from 'vitest'
import { bytesFromTerminalLogicalKey, terminalLogicalInputFromBytes } from './terminal-logical-key'

describe('terminalLogicalInputFromBytes', () => {
  it.each([
    ['\x01', 'ctrl+a'],
    ['\x03', 'ctrl+c'],
    ['\x04', 'ctrl+d'],
    ['\x15', 'ctrl+u'],
    ['\x17', 'ctrl+w'],
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
    expect(terminalLogicalInputFromBytes('\x1b[97;5u')).toEqual({ kind: 'key', name: 'ctrl+a' })
    expect(terminalLogicalInputFromBytes('\x1b[99;5u')).toEqual({ kind: 'key', name: 'ctrl+c' })
    expect(terminalLogicalInputFromBytes('\x1b[100;5u')).toEqual({ kind: 'key', name: 'ctrl+d' })
  })

  it('keeps sequences on the byte path', () => {
    expect(terminalLogicalInputFromBytes('\x1b\x7f')).toEqual({
      kind: 'key',
      name: 'alt+backspace'
    })
    expect(terminalLogicalInputFromBytes('\x1b[A')).toEqual({ kind: 'key', name: 'up' })
    expect(terminalLogicalInputFromBytes('a')).toEqual({ kind: 'bytes', data: 'a' })
    expect(terminalLogicalInputFromBytes('hello')).toEqual({ kind: 'bytes', data: 'hello' })
    expect(terminalLogicalInputFromBytes('\x1b[27;1;3u')).toEqual({
      kind: 'bytes',
      data: '\x1b[27;1;3u'
    })
  })

  it.each([
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
    ['\x1b[3~', 'delete'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[Z', 'shift+tab'],
    ['\x1b\r', 'shift+enter'],
    ['\x1b[1;5A', 'ctrl+up'],
    ['\x1b[1;3C', 'alt+right'],
    ['\x1bb', 'alt+b'],
    ['\x00', 'ctrl+space'],
    ['\x1b[13;5u', 'ctrl+enter'],
    ['\x1b[99;5:1u', 'ctrl+c'],
    ['\x1b[67;5u', 'ctrl+c'],
    ['\x1b[57352u', 'up']
  ] as const)('maps %j to %s', (bytes, key) => {
    expect(terminalLogicalInputFromBytes(bytes)).toEqual({ kind: 'key', name: key })
  })
})

describe('bytesFromTerminalLogicalKey', () => {
  it('encodes named keys back to the C0 bytes a local PTY writes', () => {
    expect(bytesFromTerminalLogicalKey('ctrl+a')).toBe('\x01')
    expect(bytesFromTerminalLogicalKey('ctrl+c')).toBe('\x03')
    expect(bytesFromTerminalLogicalKey('ctrl+j')).toBe('\n')
    expect(bytesFromTerminalLogicalKey('esc')).toBe('\x1b')
    expect(bytesFromTerminalLogicalKey('tab')).toBe('\t')
    expect(bytesFromTerminalLogicalKey('enter')).toBe('\r')
    expect(bytesFromTerminalLogicalKey('unknown')).toBeNull()
    expect(bytesFromTerminalLogicalKey('up')).toBe('\x1b[A')
    expect(bytesFromTerminalLogicalKey('shift+enter')).toBe('\x1b\r')
  })
})
