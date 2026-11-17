import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownRetainedString, resetOwnRetainedStringCopier } from '../../text/own-retained-string'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

const FISH_COMMAND = '\x1b]133;C;cmdline_url=npx'
const UTF16_CARRY = '\x1b]133;D;1234567890;\ud800a\udfff\u0000漢'

function selectCopier(withoutBuffer: boolean): void {
  resetOwnRetainedStringCopier()
  try {
    if (withoutBuffer) {
      vi.stubGlobal('Buffer', undefined)
    }
    expect(ownRetainedString(UTF16_CARRY)).toBe(UTF16_CARRY)
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetOwnRetainedStringCopier()
})

describe.each([false, true])('OSC 133 carry with Bufferless copying=%s', (withoutBuffer) => {
  // Syntax from the captured fish 4.7.1 fixture in terminal-mode-2031-final-state.test.ts.

  it('preserves UTF-16 carry at every split and retires a reset prefix', () => {
    selectCopier(withoutBuffer)
    for (let cut = 1; cut < UTF16_CARRY.length; cut += 1) {
      const finished = vi.fn()
      const scanner = createOsc133CommandFinishedScanner(finished)
      scanner.scan(UTF16_CARRY.slice(0, cut))
      scanner.scan(`${UTF16_CARRY.slice(cut)}\x1b\\`)
      expect(finished.mock.calls).toEqual([[1234567890]])
      scanner.scan(FISH_COMMAND)
      scanner.reset()
      scanner.scan('\x07')
      expect(finished.mock.calls).toEqual([[1234567890]])
    }
  })
})
