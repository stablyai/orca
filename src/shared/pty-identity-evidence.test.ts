import { describe, expect, it, vi } from 'vitest'
import { createPtyIdentityBoundaryScanner } from './pty-identity-evidence'

describe('PTY identity boundary scanner', () => {
  it('handles split OSC 133/777 markers and ignores ordinary bytes', () => {
    const seen: string[] = []
    const scanner = createPtyIdentityBoundaryScanner((boundary) => seen.push(boundary))
    scanner.feed('prompt\x1b]133;')
    scanner.feed('C\x07output\x1b]133;D;0\x1b\\')
    scanner.feed('\x1b]777;agent;started\x07')
    expect(seen).toEqual(['C', 'D', 'C'])
  })

  it('does not retain a marker after reset', () => {
    const onBoundary = vi.fn()
    const scanner = createPtyIdentityBoundaryScanner(onBoundary)
    scanner.feed('\x1b]133;')
    scanner.reset()
    scanner.feed('C\x07')
    expect(onBoundary).not.toHaveBeenCalled()
  })
})
