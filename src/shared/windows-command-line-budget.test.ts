import { describe, expect, it, vi } from 'vitest'
import { commandLineLength } from './windows-command-line-budget'

/** The regex form this estimator replaced; kept as the differential oracle. */
function referenceCommandLineLength(args: readonly string[]): number {
  return args.reduce((total, arg) => total + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0)
}

describe('windows command line budget', () => {
  it('counts quote-dense payloads without allocating a match array', () => {
    const args = ['node.exe', '-e', '"\\abc'.repeat(6000)]
    const expected = referenceCommandLineLength(args)
    const match = vi.spyOn(String.prototype, 'match')
    try {
      expect(commandLineLength(args)).toBe(expected)
      expect(match.mock.calls.length).toBe(0)
    } finally {
      match.mockRestore()
    }
  })

  it('preserves empty, Unicode, backslash and quote budget estimates', () => {
    for (const args of [[], [''], ['🦀', 'é', '\\', '"'], ['a\\\\"b', 'plain']]) {
      expect(commandLineLength(args)).toBe(referenceCommandLineLength(args))
    }
  })

  // Why: `arg.length` and the scan are both UTF-16 code units, so an astral char must
  // not shift the index of an escape that follows it.
  it('counts escapes adjacent to astral characters and lone surrogates', () => {
    for (const args of [
      ['🦀\\'],
      ['\\🦀'],
      ['🦀"🦀\\🦀'],
      ['\uD83D'],
      ['\uDE00'],
      ['\uD83D\\\uDE00"'],
      ['\uD800"\uDFFF\\'],
      ['%PATH%^"\\', 'a^^b', '%%'],
      ['trailing\\', 'trailing\\\\', '\\\\\\"']
    ]) {
      expect(commandLineLength(args)).toBe(referenceCommandLineLength(args))
    }
  })

  it('matches the regex oracle across every BMP code unit', () => {
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const args = [String.fromCharCode(unit)]
      expect(commandLineLength(args)).toBe(referenceCommandLineLength(args))
    }
  })

  // Why: the estimator seeks escapes until they look dense, then hands the rest to a
  // plain scan. Both sides of that switch, and the handover index, must agree.
  it('counts the same on either side of the dense-escape switch', () => {
    for (const args of [
      [`\\"${'x'.repeat(30000)}`],
      [`${'x'.repeat(30000)}\\"`],
      [`${'x'.repeat(5000)}${'"\\abc'.repeat(5000)}`],
      ['"'.repeat(30000)],
      ['\\'.repeat(30000)],
      ['ab"cd\\ef'.repeat(4000)],
      [`${'x'.repeat(255)}"${'x'.repeat(30000)}`],
      [`${'"x'.repeat(200)}${'y'.repeat(30000)}`]
    ]) {
      expect(commandLineLength(args)).toBe(referenceCommandLineLength(args))
    }
  })

  it('matches the regex oracle across randomized quote-heavy command lines', () => {
    const pieces = [
      '"',
      '\\',
      '\\\\',
      '\\"',
      '"\\',
      '^',
      '%VAR%',
      '🦀',
      'é',
      '中文',
      '\uD83D',
      '\uDE00',
      'C:\\Users\\n p\\repo',
      '/usr/bin/git',
      '',
      ' ',
      'plain'
    ]
    let seed = 0x2545f491
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let index = 0; index < 5000; index += 1) {
      const args = Array.from({ length: Math.floor(next() * 6) }, () =>
        Array.from(
          { length: Math.floor(next() * 30) },
          () => pieces[Math.floor(next() * pieces.length)]
        ).join('')
      )
      expect(commandLineLength(args)).toBe(referenceCommandLineLength(args))
    }
  })
})
