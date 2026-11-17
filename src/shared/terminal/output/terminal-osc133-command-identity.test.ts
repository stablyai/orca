import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

describe('attributed shell completion', () => {
  it.each(['\x07', '\x1b\\'])('preserves identity across every transport split (%j)', (end) => {
    const marker = `\x1b]133;D;130;orca_command=0123456789abcdef0123456789abcdef${end}`
    for (let split = 0; split <= marker.length; split += 1) {
      const finished = vi.fn()
      const scanner = createOsc133CommandFinishedScanner(finished)
      scanner.scan(marker.slice(0, split))
      scanner.scan(marker.slice(split))
      expect(finished.mock.calls).toEqual([[130, '0123456789abcdef0123456789abcdef']])
    }
  })

  it('recovers from abandoned metadata without combining its identity with another marker', () => {
    const finished = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(finished)
    scanner.scan('\x1b]133;D;0;orca_command=0123456789abcdef')
    scanner.scan('\x1b]133;C;orca_command=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x07')
    expect(finished).not.toHaveBeenCalled()
    scanner.scan('\x1b]133;D;2;orca_command=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x07')
    expect(finished.mock.calls).toEqual([[2, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']])
  })

  it.each([
    'D;0;orca_command=0123456789abcdef0123456789abcdef;extra',
    'D;0;orca_command=0123456789abcdef0123456789abcdef;orca_command=0123456789abcdef0123456789abcdef',
    'D;0;orca_command=0123456789abcdef0123456789abcde',
    'D;0\r;orca_command=0123456789abcdef0123456789abcdef',
    'D;0;orca_command=0123456789abcdef0123456789abcde\r'
  ])('never attributes malformed evidence %j', (payload) => {
    const finished = vi.fn()
    createOsc133CommandFinishedScanner(finished).scan(`\x1b]133;${payload}\x07`)
    expect(finished.mock.calls[0]?.[1]).toBeUndefined()
  })
})
