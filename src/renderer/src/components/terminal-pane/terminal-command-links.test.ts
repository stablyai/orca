import { describe, expect, it } from 'vitest'
import { extractShellCommandLinks } from './terminal-command-links'

describe('extractShellCommandLinks', () => {
  it('detects a bang command with a space', () => {
    expect(extractShellCommandLinks('! grep -rin orco /home/johann/jdr')).toEqual([
      { command: '! grep -rin orco /home/johann/jdr', startIndex: 0, endIndex: 33 }
    ])
  })

  it('detects a bang command without a space', () => {
    expect(extractShellCommandLinks('!ls')).toEqual([
      { command: '!ls', startIndex: 0, endIndex: 3 }
    ])
  })

  it('detects a command after a leading marker (e.g. an assistant bullet)', () => {
    const line = '● ! grep foo'
    const result = extractShellCommandLinks(line)
    expect(result).toHaveLength(1)
    expect(result[0].command).toBe('! grep foo')
    expect(line.slice(result[0].startIndex, result[0].endIndex)).toBe('! grep foo')
  })

  it('ignores trailing whitespace in the range', () => {
    expect(extractShellCommandLinks('! ls   ')).toEqual([
      { command: '! ls', startIndex: 0, endIndex: 4 }
    ])
  })

  it('does not match a bang in the middle of a word', () => {
    expect(extractShellCommandLinks('see foo!bar baz')).toEqual([])
  })

  it('does not match an exclamation at end of prose', () => {
    expect(extractShellCommandLinks('That worked great!')).toEqual([])
    expect(extractShellCommandLinks('Run this!')).toEqual([])
  })

  it('rejects bare bangs and bash history expansions', () => {
    expect(extractShellCommandLinks('!')).toEqual([])
    expect(extractShellCommandLinks('!!')).toEqual([])
    expect(extractShellCommandLinks('!  ')).toEqual([])
  })

  it('rejects a runaway line beyond the length cap', () => {
    expect(extractShellCommandLinks(`! ${'a'.repeat(4000)}`)).toEqual([])
  })
})
