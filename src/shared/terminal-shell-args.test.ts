import { describe, expect, it } from 'vitest'
import { parseShellArgs, resolveDefaultShellArgs } from './terminal-shell-args'

describe('parseShellArgs', () => {
  it('parses empty string to empty array', () => {
    expect(parseShellArgs('')).toEqual([])
    expect(parseShellArgs('   ')).toEqual([])
    expect(parseShellArgs('\t\n\r')).toEqual([])
  })

  it('parses single arguments', () => {
    expect(parseShellArgs('-l')).toEqual(['-l'])
    expect(parseShellArgs('-i')).toEqual(['-i'])
  })

  it('parses multiple arguments separated by spaces and tabs', () => {
    expect(parseShellArgs('-l -i')).toEqual(['-l', '-i'])
    expect(parseShellArgs('-f\t-i')).toEqual(['-f', '-i'])
    expect(parseShellArgs('--norc \t --noprofile')).toEqual(['--norc', '--noprofile'])
  })

  it('preserves quoted arguments with spaces and empty quoted strings', () => {
    expect(parseShellArgs('-c "echo hello world"')).toEqual(['-c', 'echo hello world'])
    expect(parseShellArgs("-c 'echo hello world'")).toEqual(['-c', 'echo hello world'])
    expect(parseShellArgs('-c ""')).toEqual(['-c', ''])
    expect(parseShellArgs("-c ''")).toEqual(['-c', ''])
    expect(parseShellArgs('""')).toEqual([''])
  })
})

describe('resolveDefaultShellArgs', () => {
  it('returns default -l when undefined', () => {
    expect(resolveDefaultShellArgs(undefined)).toEqual(['-l'])
  })

  it('returns empty array when configured as empty string', () => {
    expect(resolveDefaultShellArgs('')).toEqual([])
    expect(resolveDefaultShellArgs('   ')).toEqual([])
  })

  it('returns parsed array when configured with flags', () => {
    expect(resolveDefaultShellArgs('-l')).toEqual(['-l'])
    expect(resolveDefaultShellArgs('-f -i')).toEqual(['-f', '-i'])
    expect(resolveDefaultShellArgs('-f\t-i')).toEqual(['-f', '-i'])
  })
})
